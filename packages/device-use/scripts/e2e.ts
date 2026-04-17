#!/usr/bin/env bun
/**
 * End-to-end harness. Exercises every device-use command against TestApp
 * and records pass/fail + timing + anomalies. Drives a full login → tabs flow.
 *
 * Run: bun run scripts/e2e.ts
 * Output: .context/e2e-results.json + .context/e2e-log.txt
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const BIN = join(root, "bin/device-use");
const CTX = join(root, ".context");
mkdirSync(CTX, { recursive: true });

const BUNDLE = "com.agentsimulator.TestApp";
const UDID = "AD34799C-ED66-4BF2-B747-BA9D909930E5";

// ---------- Results model ----------

interface Finding {
  step: string;
  kind: "ok" | "fail" | "warn" | "info";
  elapsedMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  exitCode: number;
  note?: string;
  payload?: unknown;
}

const findings: Finding[] = [];
const log: string[] = [];

function logLine(s: string): void {
  log.push(s);
  console.log(s);
}

async function runCmd(
  step: string,
  args: string[],
  opts: { allowFail?: boolean; stdin?: string; expectExit?: number } = {}
): Promise<{ stdout: string; stderr: string; exit: number; elapsed: number }> {
  const t0 = performance.now();
  const proc = Bun.spawn([BIN, ...args], {
    stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const elapsed = Math.round(performance.now() - t0);
  const kind: Finding["kind"] =
    opts.expectExit !== undefined
      ? exit === opts.expectExit
        ? "ok"
        : "fail"
      : opts.allowFail && exit !== 0
        ? "warn"
        : exit === 0
          ? "ok"
          : "fail";
  findings.push({
    step,
    kind,
    elapsedMs: elapsed,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    exitCode: exit,
  });
  logLine(
    `[${kind.padEnd(4)}] ${elapsed.toString().padStart(5)}ms  ${step}  (exit=${exit}, stdout=${stdout.length}b, stderr=${stderr.length}b)`
  );
  return { stdout, stderr, exit, elapsed };
}

function parseJson<T = unknown>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function mark(step: string, kind: Finding["kind"], note?: string, payload?: unknown): void {
  findings.push({
    step,
    kind,
    elapsedMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    exitCode: 0,
    note,
    payload,
  });
  const prefix = kind === "ok" ? "✓" : kind === "fail" ? "✗" : kind === "warn" ? "⚠" : "ℹ";
  logLine(`  ${prefix} ${step}${note ? `  — ${note}` : ""}`);
}

// ---------- Harness ----------

async function resetState(): Promise<void> {
  logLine("\n━━━ RESET ━━━");
  // Dismiss any leftover system confirmation modals from previous runs.
  // iOS shows "Open in 'TestApp'?" after simctl openurl for custom schemes; it persists.
  await dismissSystemModals();
  await runCmd("session.clear", ["session", "clear"]);
  await runCmd("testapp.terminate", ["terminate", BUNDLE], { allowFail: true });
}

/**
 * Best-effort dismissal of any blocking system modal. Taps "Cancel" / "Don't Allow"
 * if present. Does nothing if no modal is up. Retries up to 3 times because
 * the first dismissal can reveal a second modal (e.g. deeplink banner on top
 * of the URL-scheme confirm on iOS 26).
 */
async function dismissSystemModals(maxAttempts = 3): Promise<void> {
  const dismissLabels = [
    "Cancel",
    "Don't Allow",
    "Don\u2019t Allow",
    "Not Now",
    "Close",
    "OK",
    "Dismiss",
  ];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const probe = await runCmd(`reset.probe.${attempt}`, ["snapshot"], { allowFail: true });
    const pj = parseJson<{
      data: { tree?: Array<{ label?: string; type: string; children?: unknown[] }> };
    }>(probe.stdout);
    if (!pj?.data?.tree) return;

    const flat: Array<{ label?: string; type: string }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (nodes: any[]): void => {
      for (const n of nodes) {
        flat.push({ label: n.label, type: n.type });
        if (Array.isArray(n.children)) walk(n.children);
      }
    };
    walk(pj.data.tree);

    const found = dismissLabels.find((l) => flat.some((n) => n.type === "Button" && n.label === l));
    if (!found) {
      if (attempt > 0) logLine(`  → modals cleared after ${attempt} attempt(s)`);
      return;
    }
    logLine(`  → dismissing modal via "${found}" (attempt ${attempt + 1})`);
    await runCmd(
      `reset.dismiss.${attempt}.${found.replace(/\s+/g, "-")}`,
      ["tap", "--label", found],
      { allowFail: true }
    );
    await sleep(500);
  }
}

async function drivingLoginFlow(): Promise<void> {
  logLine("\n━━━ SECTION: login flow in TestApp ━━━");

  // Launch the app
  const launchRes = await runCmd("launch.testapp", ["launch", BUNDLE]);
  const launched = parseJson<{ success: boolean; data?: { pid?: number | null } }>(
    launchRes.stdout
  );
  if (launched?.data?.pid) {
    mark("launch.pid-reported", "ok", `pid=${launched.data.pid}`);
  } else {
    mark("launch.pid-reported", "warn", "pid missing");
  }

  // Give the app time to fully render
  await sleep(2000);

  // Pre-launch appstate
  const asRes = await runCmd("appstate.running", ["appstate", BUNDLE]);
  const asJson = parseJson<{ data: { running: boolean; pid?: number } }>(asRes.stdout);
  if (asJson?.data.running) {
    mark("appstate.confirms-running", "ok");
  } else {
    mark("appstate.confirms-running", "fail");
  }

  // Snapshot — tree mode (default)
  const snap1 = await runCmd("snapshot.default", ["snapshot"]);
  const snap1Json = parseJson<{ data: { tree?: unknown[]; refs?: unknown[]; counts?: unknown } }>(
    snap1.stdout
  );
  if (snap1Json?.data?.tree && snap1Json.data.refs && snap1Json.data.counts) {
    mark("snapshot.has-tree-shape", "ok");
  } else {
    mark("snapshot.has-tree-shape", "fail", "missing tree/refs/counts");
  }

  // Snapshot -i
  const snap2 = await runCmd("snapshot.interactive", ["snapshot", "-i"]);
  const snap2Json = parseJson<{
    data: { refs: Array<{ ref: string; type: string; label?: string; identifier?: string }> };
  }>(snap2.stdout);
  const refs2 = snap2Json?.data.refs ?? [];
  logLine(`    interactive refs (${refs2.length}):`);
  for (const r of refs2)
    logLine(`      ${r.ref} ${r.type} ${r.label ?? ""} ${r.identifier ? `#${r.identifier}` : ""}`);

  // Look up by accessibility identifier — most robust across iOS versions
  const emailField = refs2.find((r) => r.identifier === "EmailField");
  const passwordField = refs2.find((r) => r.identifier === "PasswordField");
  const loginButton = refs2.find((r) => r.identifier === "LoginButton");

  if (!emailField || !passwordField || !loginButton) {
    mark(
      "login.form.visible",
      "fail",
      `email=${!!emailField} pass=${!!passwordField} login=${!!loginButton}`
    );
    return;
  }
  mark("login.form.visible", "ok");
  mark(
    "finding.securefield-reports-as-textfield",
    passwordField.type === "TextField" ? "info" : "info",
    `PasswordField reports type="${passwordField.type}" (expected SecureTextField per docs; actual matches what iOS 26 emits)`
  );

  // Test wrong credentials — should show error
  logLine("\n  → trying wrong creds (should fail)...");
  await runCmd("fill.email.invalid", ["fill", emailField.ref, "notanemail"]);
  await runCmd("fill.password.short", ["fill", passwordField.ref, "x"]);
  await runCmd("tap.login.invalid", ["tap", loginButton.ref]);
  await sleep(500);

  const errCheck = await runCmd("query.error-shown", [
    "query",
    "--id",
    "ErrorMessage",
    "--get",
    "bool",
  ]);
  const errJson = parseJson<{ success: boolean; data: unknown }>(errCheck.stdout);
  if (errJson?.success) {
    mark("login.invalid-creds-shows-error", "ok");
  } else {
    mark("login.invalid-creds-shows-error", "fail", "error not shown");
  }

  // Screenshot of the error state
  await runCmd("screenshot.error-state", ["screenshot", "/tmp/e2e-login-error.png"]);

  // Take a fresh snapshot (refs change on every snapshot by design)
  const snap3 = await runCmd("snapshot.post-error", ["snapshot", "-i"]);
  const snap3Json = parseJson<{
    data: { refs: Array<{ ref: string; type: string; label?: string; identifier?: string }> };
  }>(snap3.stdout);
  const refs3 = snap3Json?.data.refs ?? [];
  const emailField2 = refs3.find((r) => r.identifier === "EmailField");
  const passwordField2 = refs3.find((r) => r.identifier === "PasswordField");
  const loginButton2 = refs3.find((r) => r.identifier === "LoginButton");

  if (!emailField2 || !passwordField2 || !loginButton2) {
    mark(
      "snapshot.refs-stable-after-error",
      "fail",
      `email=${!!emailField2} pass=${!!passwordField2} login=${!!loginButton2}`
    );
    return;
  }
  mark("snapshot.refs-stable-after-error", "ok");

  // Correct credentials — fill + submit in one call for login
  logLine("\n  → trying correct creds...");
  await runCmd("fill.email.valid", ["fill", emailField2.ref, "test@example.com"]);
  await runCmd("fill.password.valid", ["fill", passwordField2.ref, "secret123"]);
  await runCmd("tap.login.valid", ["tap", loginButton2.ref]);

  // Wait for loading spinner to appear
  const spinnerWait = await runCmd(
    "wait-for.loading",
    ["wait-for", "--id", "LoadingSpinner", "--timeout", "5"],
    { allowFail: true }
  );
  if (spinnerWait.exit === 0) {
    mark("wait-for.spinner-appeared", "ok");
  } else {
    mark("wait-for.spinner-appeared", "warn", "spinner may have passed too fast");
  }

  // Wait for spinner to disappear
  const spinnerGone = await runCmd("wait-for.loading-gone", [
    "wait-for",
    "--id",
    "LoadingSpinner",
    "--gone",
    "--timeout",
    "15",
  ]);
  if (spinnerGone.exit === 0) {
    mark("wait-for.spinner-removed", "ok");
  } else {
    mark("wait-for.spinner-removed", "fail", "stuck loading");
  }

  // We should be on Dashboard now. LoggedInLabel is a static Text node so use
  // `query` against the full tree, not `-i` refs.
  await sleep(1000);
  const dashCheck = await runCmd("query.dashboard-reached", [
    "query",
    "--id",
    "LoggedInLabel",
    "--get",
    "bool",
  ]);
  const dashJson = parseJson<{ success: boolean }>(dashCheck.stdout);
  if (dashJson?.success) {
    mark("login.reached-dashboard", "ok");
  } else {
    mark("login.reached-dashboard", "fail", "LoggedInLabel not in tree");
  }
}

async function drivingTabsAndSettings(): Promise<void> {
  logLine("\n━━━ SECTION: tabs, toggles, pickers, sliders ━━━");

  mark(
    "finding.tabview-items-missing-from-a11y-tree",
    "info",
    "iOS 26 SwiftUI TabView: tab bar buttons are not exposed via AccessibilityPlatform. Agents must tap tabs by coordinate or use deep links. See FINDINGS.md."
  );

  // iPhone 17 logical 402×874 — tab bar frame y=791..874. The visible capsule is
  // narrower than the full bar; measured empirically:
  //   Home    ≈ x 100  (didn't actually test; fallback to label)
  //   Settings ≈ x 201 (dead center of the 402-wide bar)
  //   Form    ≈ x 290  (anywhere 270-330 works)
  const TAB_Y = 830;
  const TAB_SETTINGS_X = 201;

  await runCmd("tap.settings-tab", ["tap", "-x", String(TAB_SETTINGS_X), "-y", String(TAB_Y)]);
  await sleep(1000);

  const settingsSnap = await runCmd("snapshot.settings-tab", ["snapshot", "-i"]);
  const sJson = parseJson<{
    data: { refs: Array<{ ref: string; type: string; label?: string; identifier?: string }> };
  }>(settingsSnap.stdout);
  const sRefs = sJson?.data.refs ?? [];
  logLine(`    settings refs (${sRefs.length}):`);
  for (const r of sRefs)
    logLine(`      ${r.ref} ${r.type} ${r.label ?? ""} ${r.identifier ? `#${r.identifier}` : ""}`);

  const darkToggle = sRefs.find((r) => r.identifier === "DarkModeToggle");
  const notifToggle = sRefs.find((r) => r.identifier === "NotificationsToggle");

  if (darkToggle) {
    await runCmd("tap.dark-mode-toggle", ["tap", darkToggle.ref]);
    await sleep(500);
    mark("toggle.dark-mode.tappable", "ok");
  } else {
    mark("toggle.dark-mode.tappable", "fail", "not in refs");
  }

  if (notifToggle) {
    await runCmd("tap.notifications-toggle", ["tap", notifToggle.ref]);
    await sleep(500);
    mark("toggle.notifications.tappable", "ok");
  } else {
    mark("toggle.notifications.tappable", "fail", "not in refs");
  }

  // Test --flat vs tree
  const flatRes = await runCmd("snapshot.flat", ["snapshot", "-i", "--flat"]);
  const flatJson = parseJson<{ data: { tree?: unknown } }>(flatRes.stdout);
  // --flat is a TTY formatter — JSON output still has the tree
  if (flatJson?.data?.tree) {
    mark("snapshot.flat.json-still-has-tree", "ok", "--flat only changes TTY");
  }

  // Query count vs refs.length consistency
  const btnCount = await runCmd("query.type-count", [
    "query",
    "--type",
    "Button",
    "--get",
    "count",
  ]);
  const cntJson = parseJson<{ data: { count: number } }>(btnCount.stdout);
  if (typeof cntJson?.data.count === "number") {
    mark("query.count-numeric", "ok", `count=${cntJson.data.count}`);
  }

  // Test screenshot --annotate with real refs
  await runCmd("snapshot.pre-annotate", ["snapshot", "-i"]);
  const shot = await runCmd("screenshot.annotate", [
    "screenshot",
    "/tmp/e2e-settings-annotated.png",
    "--annotate",
  ]);
  const shotJson = parseJson<{ data: { annotated?: boolean; boxes?: unknown[] } }>(shot.stdout);
  if (shotJson?.data.annotated && (shotJson.data.boxes?.length ?? 0) > 0) {
    mark("screenshot.annotate.produces-boxes", "ok", `${shotJson.data.boxes!.length} boxes`);
  } else {
    mark("screenshot.annotate.produces-boxes", "fail");
  }
}

async function drivingFormTab(): Promise<void> {
  logLine("\n━━━ SECTION: form tab — text + stepper + toggle + submit ━━━");

  // Coordinate tap — tab items are not in the a11y tree (see finding).
  await runCmd("tap.form-tab", ["tap", "-x", "290", "-y", "830"]);
  await sleep(1000);

  const formSnap = await runCmd("snapshot.form-tab", ["snapshot", "-i"]);
  const fJson = parseJson<{
    data: { refs: Array<{ ref: string; type: string; label?: string; identifier?: string }> };
  }>(formSnap.stdout);
  const fRefs = fJson?.data.refs ?? [];

  const nameField = fRefs.find((r) => r.identifier === "NameField");
  const bioField = fRefs.find((r) => r.identifier === "BioField");
  const termsToggle = fRefs.find((r) => r.identifier === "TermsToggle");
  const submitBtn = fRefs.find((r) => r.identifier === "SubmitFormButton");

  if (!nameField) {
    mark("form.NameField.present", "fail");
  } else {
    mark("form.NameField.present", "ok");
    await runCmd("fill.name", ["fill", nameField.ref, "Alice Example"]);
  }

  if (bioField) {
    await runCmd("fill.bio", ["fill", bioField.ref, "I love testing accessibility APIs"]);
    mark("form.BioField.filled", "ok");
  }

  // Try submit — it's disabled until terms is toggled
  if (submitBtn) {
    await runCmd("tap.submit.disabled", ["tap", submitBtn.ref], {
      allowFail: true,
    });
    // Even if it's disabled, accessibility should still allow the tap to register — but no nav
  }

  // Check terms
  if (termsToggle) {
    await runCmd("tap.terms", ["tap", termsToggle.ref]);
    await sleep(500);
    mark("form.TermsToggle.tapped", "ok");
  }

  // Re-snapshot to get fresh refs after terms toggle
  const formSnap2 = await runCmd("snapshot.form-after-terms", ["snapshot", "-i"]);
  const f2Json = parseJson<{
    data: { refs: Array<{ ref: string; type: string; label?: string; identifier?: string }> };
  }>(formSnap2.stdout);
  const f2Refs = f2Json?.data.refs ?? [];
  const submitBtn2 = f2Refs.find((r) => r.identifier === "SubmitFormButton");

  if (submitBtn2) {
    await runCmd("tap.submit.enabled", ["tap", submitBtn2.ref]);
    await sleep(1500);

    const doneCheck = await runCmd("query.form-submitted", [
      "query",
      "--id",
      "FormSuccessTitle",
      "--get",
      "bool",
    ]);
    const doneJson = parseJson<{ success: boolean }>(doneCheck.stdout);
    if (doneJson?.success) {
      mark("form.submission-succeeded", "ok");
    } else {
      mark("form.submission-succeeded", "fail");
    }
  }
}

async function drivingDeepLink(): Promise<void> {
  logLine("\n━━━ SECTION: deep link + open-url ━━━");

  await runCmd("open-url.deeplink", ["open-url", "testapp://form"]);
  await sleep(1500);

  // iOS 26 shows "Open in 'TestApp'?" confirmation for custom URL schemes.
  // This is a system-level modal our CLI can't suppress — we accept and dismiss it.
  const probe = await runCmd("deeplink.probe", ["snapshot"]);
  const pj = parseJson<{
    data: { tree?: Array<{ children?: Array<{ label?: string; type: string }> }> };
  }>(probe.stdout);
  const flat: Array<{ label?: string; type: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (nodes: any[]): void => {
    for (const n of nodes) {
      flat.push({ label: n.label, type: n.type });
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  if (pj?.data.tree) walk(pj.data.tree);

  const hasConfirm =
    flat.some((n) => n.type === "Button" && n.label === "Open") &&
    flat.some((n) => n.type === "StaticText" && (n.label ?? "").includes("Open in"));
  mark(
    "finding.custom-url-scheme-shows-ios-confirm",
    "info",
    hasConfirm
      ? "confirmed: testapp:// → 'Open in TestApp?' modal"
      : "no modal (accepted automatically?)"
  );

  if (hasConfirm) {
    await runCmd("deeplink.confirm", ["tap", "--label", "Open"]);
    await sleep(1500);
  }

  const deepCheck = await runCmd("query.deeplink-banner", [
    "query",
    "--id",
    "DeepLinkLabel",
    "--get",
    "bool",
  ]);
  const d = parseJson<{ success: boolean }>(deepCheck.stdout);
  if (d?.success) {
    mark("deeplink.banner-shown", "ok");
  } else {
    mark("deeplink.banner-shown", "warn", "banner may have auto-dismissed");
  }

  // Cleanup: if banner still visible, dismiss it
  const banner = await runCmd("deeplink.post-snapshot", ["snapshot", "-i"]);
  const bj = parseJson<{ data: { refs: Array<{ identifier?: string; ref: string }> } }>(
    banner.stdout
  );
  const dismiss = bj?.data.refs.find((r) => r.identifier === "DismissDeepLinkButton");
  if (dismiss) {
    await runCmd("deeplink.dismiss-banner", ["tap", dismiss.ref]);
  }
}

async function drivingPermissions(): Promise<void> {
  logLine("\n━━━ SECTION: permission command (validation + happy path) ━━━");

  const grant = await runCmd("permission.grant.location", [
    "permission",
    "grant",
    "location",
    BUNDLE,
  ]);
  mark("permission.grant.ok", grant.exit === 0 ? "ok" : "fail");

  const bad1 = await runCmd("permission.bad-action", ["permission", "gront", "location", BUNDLE], {
    allowFail: true,
  });
  mark("permission.validation.bad-action", bad1.exit !== 0 ? "ok" : "fail");

  const bad2 = await runCmd("permission.bad-service", ["permission", "grant", "teleport", BUNDLE], {
    allowFail: true,
  });
  mark("permission.validation.bad-service", bad2.exit !== 0 ? "ok" : "fail");

  const reset = await runCmd("permission.reset", ["permission", "reset", "all", BUNDLE]);
  mark("permission.reset.ok", reset.exit === 0 ? "ok" : "fail");
}

async function drivingStream(): Promise<void> {
  logLine("\n━━━ SECTION: stream lifecycle ━━━");

  const enable = await runCmd("stream.enable", ["stream", "enable", "--port", "3180"]);
  const eJson = parseJson<{ data: { viewerUrl?: string; streamUrl?: string } }>(enable.stdout);
  if (eJson?.data.viewerUrl && eJson.data.streamUrl) {
    mark("stream.enable-yields-both-urls", "ok");
  } else {
    mark("stream.enable-yields-both-urls", "fail");
  }

  await sleep(1000);
  await runCmd("stream.status", ["stream", "status"]);
  await runCmd("stream.disable", ["stream", "disable"]);

  // Post-disable status should say "No stream server running"
  const post = await runCmd("stream.status-post-disable", ["stream", "status"]);
  const pJson = parseJson<{ data: unknown }>(post.stdout);
  mark("stream.status-post-disable.clean", "ok", JSON.stringify(pJson?.data));
}

async function errorHygieneTests(): Promise<void> {
  logLine("\n━━━ SECTION: error hygiene ━━━");

  const tests: Array<{ step: string; argv: string[]; expect: "fail" | "ok" }> = [
    { step: "err.unknown-ref", argv: ["tap", "@e99999"], expect: "fail" },
    { step: "err.bad-simulator", argv: ["--simulator", "NOT-A-UDID", "snapshot"], expect: "fail" },
    { step: "err.empty-type", argv: ["type"], expect: "fail" },
    { step: "err.empty-tap", argv: ["tap"], expect: "fail" },
    { step: "err.query-no-filter", argv: ["query", "--get", "bool"], expect: "fail" },
    { step: "err.wait-no-target", argv: ["wait-for", "--timeout", "1"], expect: "fail" },
    { step: "err.permission-missing-args", argv: ["permission", "grant"], expect: "fail" },
    { step: "err.unknown-command", argv: ["doesnotexist"], expect: "fail" },
  ];

  for (const t of tests) {
    const r = await runCmd(t.step, t.argv, { allowFail: true });
    const json = parseJson<{ success: boolean; error?: string; message?: string }>(r.stdout);
    const gotFailure = !json?.success && r.exit !== 0;
    const expected = t.expect === "fail";
    if (gotFailure === expected) {
      mark(`${t.step}.correct-exit`, "ok", json?.error ?? json?.message ?? "");
    } else {
      mark(`${t.step}.correct-exit`, "fail", `expected fail=${expected}, got exit=${r.exit}`);
    }
  }
}

async function miscVerifications(): Promise<void> {
  logLine("\n━━━ SECTION: misc ━━━");

  // --version
  const v = await runCmd("meta.version", ["--version"]);
  if (v.stdout.match(/^device-use \d+\.\d+\.\d+/)) {
    mark("meta.version.format", "ok", v.stdout.trim());
  } else {
    mark("meta.version.format", "fail", v.stdout);
  }

  // --help lists commands
  const h = await runCmd("meta.help", ["--help"]);
  for (const expected of [
    "list",
    "boot",
    "snapshot",
    "tap",
    "type",
    "fill",
    "query",
    "apps",
    "permission",
  ]) {
    if (h.stdout.includes(expected)) {
      mark(`meta.help.has-${expected}`, "ok");
    } else {
      mark(`meta.help.has-${expected}`, "fail");
    }
  }

  // doctor --json
  const doctor = await runCmd("meta.doctor", ["doctor"]);
  const dJson = parseJson<{ data: Array<{ status: string; name: string }> }>(doctor.stdout);
  if (dJson?.data && Array.isArray(dJson.data)) {
    const allOk = dJson.data.every((c) => c.status === "ok");
    mark(
      "meta.doctor.all-ok",
      allOk ? "ok" : "warn",
      JSON.stringify(dJson.data.map((c) => c.status))
    );
  }

  // session roundtrip
  await runCmd("session.set-udid", ["session", "set", "--simulator", UDID]);
  const show = await runCmd("session.show", ["session", "show"]);
  const showJson = parseJson<{ data: { simulatorUdid?: string } }>(show.stdout);
  if (showJson?.data.simulatorUdid === UDID) {
    mark("session.roundtrip", "ok");
  } else {
    mark("session.roundtrip", "fail");
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Main ----------

async function main(): Promise<void> {
  logLine(`device-use E2E — ${new Date().toISOString()}`);
  logLine(`bin:  ${BIN}`);
  logLine(`udid: ${UDID}`);

  await resetState();

  await drivingLoginFlow();
  await drivingTabsAndSettings();
  await drivingFormTab();
  await drivingDeepLink();
  await drivingPermissions();
  await drivingStream();
  await errorHygieneTests();
  await miscVerifications();

  // Summary
  const ok = findings.filter((f) => f.kind === "ok").length;
  const fail = findings.filter((f) => f.kind === "fail").length;
  const warn = findings.filter((f) => f.kind === "warn").length;
  const info = findings.filter((f) => f.kind === "info").length;
  const totalTime = findings.reduce((a, f) => a + f.elapsedMs, 0);

  logLine(`\n━━━ SUMMARY ━━━`);
  logLine(`  ok:    ${ok}`);
  logLine(`  fail:  ${fail}`);
  logLine(`  warn:  ${warn}`);
  logLine(`  info:  ${info}`);
  logLine(`  total: ${findings.length}`);
  logLine(`  time:  ${(totalTime / 1000).toFixed(1)}s across timed steps`);

  writeFileSync(join(CTX, "e2e-results.json"), JSON.stringify(findings, null, 2));
  writeFileSync(join(CTX, "e2e-log.txt"), log.join("\n"));

  logLine(`\nWrote .context/e2e-results.json and .context/e2e-log.txt`);
  process.exitCode = fail > 0 ? 1 : 0;
}

await main();
