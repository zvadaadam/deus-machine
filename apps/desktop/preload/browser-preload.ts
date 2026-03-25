/**
 * Browser View Preload Script
 *
 * Injected into BrowserView content pages (the agent browser).
 *
 * Responsibilities:
 * 1. Console capture — forward to main process for the console panel
 * 2. Dialog override — alert/confirm/prompt are non-blocking (prevents app freeze)
 * 3. WebAuthn polyfill — graceful rejection so passkey prompts don't hang
 * 4. Local network access polyfill — auto-grant for auth domains (Okta, Duo, etc.)
 * 5. Keyboard shortcut routing — Cmd+R/L route back to IDE
 */

import { ipcRenderer, webFrame } from "electron";

// ---------------------------------------------------------------------------
// Console capture — forward to main process
// ---------------------------------------------------------------------------

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
};

function forwardConsole(level: string, args: unknown[]): void {
  try {
    const serialized = args.map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    });
    ipcRenderer.send("browser:console-message", { level, args: serialized });
  } catch {
    // Swallow errors — never break page JS
  }
}

console.log = (...args: unknown[]) => {
  originalConsole.log(...args);
  forwardConsole("log", args);
};

console.warn = (...args: unknown[]) => {
  originalConsole.warn(...args);
  forwardConsole("warn", args);
};

console.error = (...args: unknown[]) => {
  originalConsole.error(...args);
  forwardConsole("error", args);
};

console.info = (...args: unknown[]) => {
  originalConsole.info(...args);
  forwardConsole("info", args);
};

// ---------------------------------------------------------------------------
// Override blocking dialogs to be non-blocking
// ---------------------------------------------------------------------------

window.alert = (message?: string) => {
  originalConsole.log("[alert]", message);
};

window.confirm = (_message?: string) => {
  originalConsole.log("[confirm]", _message);
  return true; // Always confirm
};

window.prompt = (_message?: string, _defaultValue?: string) => {
  originalConsole.log("[prompt]", _message);
  return _defaultValue ?? null;
};

// ---------------------------------------------------------------------------
// WebAuthn polyfill — graceful rejection for passkey/FIDO2 requests
//
// BrowserViews don't support WebAuthn. Without this polyfill, pages that
// call navigator.credentials.create/get() with publicKey hang indefinitely
// waiting for an authenticator response that never comes.
//
// Wrap the native methods, apply a 45s abort timeout,
// and report "NotSupportedError" so the page can fall back to password auth.
// ---------------------------------------------------------------------------

try {
  webFrame.executeJavaScript(`
    (function() {
      if (typeof navigator === 'undefined' || !navigator.credentials) return;
      if (navigator.credentials.__webAuthnPolyfillApplied) return;
      navigator.credentials.__webAuthnPolyfillApplied = true;

      var ABORT_DELAY_MS = 45000;

      function createNotSupportedError() {
        return new DOMException(
          'WebAuthn is not supported in the Deus browser.',
          'NotSupportedError'
        );
      }

      var origCreate = navigator.credentials.create;
      var origGet = navigator.credentials.get;

      function wrapWebAuthn(originalMethod, options, args) {
        if (!originalMethod) return Promise.reject(createNotSupportedError());

        var callerSignal = options && options.signal;
        if (callerSignal && callerSignal.aborted) {
          return Promise.reject(callerSignal.reason || new DOMException('Aborted', 'AbortError'));
        }

        var ac = typeof AbortController === 'function' ? new AbortController() : undefined;
        var reqArgs = Array.prototype.slice.call(args);
        if (ac) reqArgs[0] = Object.assign({}, options, { signal: ac.signal });

        var done = false;
        var timer;

        return new Promise(function(resolve, reject) {
          timer = setTimeout(function() {
            if (done) return;
            done = true;
            if (ac) ac.abort();
            reject(new DOMException('WebAuthn timed out.', 'TimeoutError'));
          }, ABORT_DELAY_MS);

          Promise.resolve().then(function() {
            return originalMethod.apply(navigator.credentials, reqArgs);
          }).then(
            function(v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
            function(e) { if (!done) { done = true; clearTimeout(timer); reject(e); } }
          );
        });
      }

      navigator.credentials.create = function(options) {
        if (options && options.publicKey) return wrapWebAuthn(origCreate, options, arguments);
        return origCreate ? origCreate.apply(navigator.credentials, arguments) : Promise.reject(createNotSupportedError());
      };

      navigator.credentials.get = function(options) {
        if (options && options.publicKey) return wrapWebAuthn(origGet, options, arguments);
        return origGet ? origGet.apply(navigator.credentials, arguments) : Promise.reject(createNotSupportedError());
      };

      if (typeof PublicKeyCredential !== 'undefined') {
        PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function() {
          return Promise.resolve(false);
        };
        if (typeof PublicKeyCredential.isConditionalMediationAvailable === 'function') {
          PublicKeyCredential.isConditionalMediationAvailable = function() {
            return Promise.resolve(false);
          };
        }
      }
    })();
  `);
} catch (e) {
  originalConsole.error("[browser-preload] WebAuthn polyfill injection failed:", e);
}

// ---------------------------------------------------------------------------
// Local network access permission polyfill
//
// Corporate auth pages (Okta, Duo, Microsoft, Auth0, etc.) sometimes query
// navigator.permissions for "local-network-access". Without granting it,
// the auth flow can stall. Auto-grant on known auth domains only.
// ---------------------------------------------------------------------------

const AUTH_DOMAINS = [
  ".okta.com",
  ".okta-emea.com",
  ".oktapreview.com",
  ".duosecurity.com",
  ".duo.com",
  ".login.microsoftonline.com",
  ".onelogin.com",
  ".auth0.com",
  ".pingidentity.com",
  ".pingone.com",
  ".rippling.com",
];

function injectLocalNetworkPolyfill(): void {
  try {
    const hostname = window.location.hostname.toLowerCase();
    if (!AUTH_DOMAINS.some((d) => hostname === d.slice(1) || hostname.endsWith(d))) return;

    webFrame.executeJavaScript(`
      (function() {
        if (typeof navigator === 'undefined' || !navigator.permissions || !navigator.permissions.query) return;
        if (navigator.permissions.__localNetworkPolyfillApplied) return;
        navigator.permissions.__localNetworkPolyfillApplied = true;

        var origQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = function(descriptor) {
          if (descriptor && (descriptor.name === 'local-network-access' || descriptor.name === 'local-network')) {
            return Promise.resolve({
              state: 'granted',
              name: descriptor.name,
              onchange: null,
              addEventListener: function() {},
              removeEventListener: function() {},
              dispatchEvent: function() { return true; }
            });
          }
          return origQuery(descriptor);
        };
      })();
    `);
  } catch (e) {
    originalConsole.error("[browser-preload] Local network polyfill failed:", e);
  }
}

injectLocalNetworkPolyfill();

// ---------------------------------------------------------------------------
// Keyboard shortcut routing
//
// When the BrowserView is focused, browser shortcuts (Cmd+R, Cmd+L, etc.)
// would be consumed by the webview. Route them to the IDE instead so the
// user gets expected behavior regardless of focus state.
// ---------------------------------------------------------------------------

window.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;

    switch (e.key) {
      case "r":
        // Cmd+R → reload the BrowserView (not the IDE)
        e.preventDefault();
        e.stopPropagation();
        ipcRenderer.send("browser:keyboard-shortcut", { shortcut: "reload" });
        break;
      case "l":
        // Cmd+L → focus the URL bar in our IDE
        e.preventDefault();
        e.stopPropagation();
        ipcRenderer.send("browser:keyboard-shortcut", { shortcut: "focus-url-bar" });
        break;
    }
  },
  true // capture phase — intercept before page handlers
);
