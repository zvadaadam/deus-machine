"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// socket-server.js
var require_socket_server = __commonJS({
  "socket-server.js"(exports2, module2) {
    "use strict";
    var net = require("net");
    var fs = require("fs");
    var os = require("os");
    var path = require("path");
    var SocketServer2 = class {
      constructor(messageHandler) {
        this.messageHandler = messageHandler;
        this.server = null;
        this.socketPath = null;
        this.clients = /* @__PURE__ */ new Set();
      }
      /**
       * Start the socket server
       */
      async start() {
        return new Promise((resolve, reject) => {
          this.socketPath = path.join(
            os.tmpdir(),
            `conductor-claude-${process.pid}.sock`
          );
          if (fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
          }
          this.server = net.createServer((socket) => {
            this.handleConnection(socket);
          });
          this.server.listen(this.socketPath, () => {
            resolve();
          });
          this.server.on("error", (error) => {
            console.error("[SOCKET] Server error:", error);
            reject(error);
          });
        });
      }
      /**
       * Handle new client connection
       */
      handleConnection(socket) {
        console.log("[SOCKET] Client connected");
        this.clients.add(socket);
        let buffer = "";
        socket.on("data", (data) => {
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (line.trim()) {
              this.handleMessage(socket, line);
            }
          }
        });
        socket.on("end", () => {
          console.log("[SOCKET] Client disconnected");
          this.clients.delete(socket);
        });
        socket.on("error", (error) => {
          console.error("[SOCKET] Socket error:", error);
          this.clients.delete(socket);
        });
      }
      /**
       * Handle incoming message
       */
      async handleMessage(socket, line) {
        try {
          const message = JSON.parse(line);
          console.log("[SOCKET] Received:", message.command);
          const response = await this.messageHandler(message);
          this.send(socket, response);
        } catch (error) {
          console.error("[SOCKET] Error handling message:", error);
          this.send(socket, { error: error.message });
        }
      }
      /**
       * Send message to a specific client
       */
      send(socket, message) {
        try {
          const json = JSON.stringify(message) + "\n";
          socket.write(json);
        } catch (error) {
          console.error("[SOCKET] Error sending message:", error);
        }
      }
      /**
       * Broadcast message to all clients
       */
      broadcast(message) {
        for (const client of this.clients) {
          this.send(client, message);
        }
      }
      /**
       * Get socket path
       */
      getSocketPath() {
        return this.socketPath;
      }
      /**
       * Stop the server
       */
      async stop() {
        return new Promise((resolve) => {
          if (this.server) {
            for (const client of this.clients) {
              client.end();
            }
            this.clients.clear();
            this.server.close(() => {
              if (this.socketPath && fs.existsSync(this.socketPath)) {
                fs.unlinkSync(this.socketPath);
              }
              resolve();
            });
          } else {
            resolve();
          }
        });
      }
    };
    module2.exports = { SocketServer: SocketServer2 };
  }
});

// node_modules/better-sqlite3/lib/util.js
var require_util = __commonJS({
  "node_modules/better-sqlite3/lib/util.js"(exports2) {
    "use strict";
    exports2.getBooleanOption = (options, key) => {
      let value = false;
      if (key in options && typeof (value = options[key]) !== "boolean") {
        throw new TypeError(`Expected the "${key}" option to be a boolean`);
      }
      return value;
    };
    exports2.cppdb = Symbol();
    exports2.inspect = Symbol.for("nodejs.util.inspect.custom");
  }
});

// node_modules/better-sqlite3/lib/sqlite-error.js
var require_sqlite_error = __commonJS({
  "node_modules/better-sqlite3/lib/sqlite-error.js"(exports2, module2) {
    "use strict";
    var descriptor = { value: "SqliteError", writable: true, enumerable: false, configurable: true };
    function SqliteError(message, code) {
      if (new.target !== SqliteError) {
        return new SqliteError(message, code);
      }
      if (typeof code !== "string") {
        throw new TypeError("Expected second argument to be a string");
      }
      Error.call(this, message);
      descriptor.value = "" + message;
      Object.defineProperty(this, "message", descriptor);
      Error.captureStackTrace(this, SqliteError);
      this.code = code;
    }
    Object.setPrototypeOf(SqliteError, Error);
    Object.setPrototypeOf(SqliteError.prototype, Error.prototype);
    Object.defineProperty(SqliteError.prototype, "name", descriptor);
    module2.exports = SqliteError;
  }
});

// node_modules/file-uri-to-path/index.js
var require_file_uri_to_path = __commonJS({
  "node_modules/file-uri-to-path/index.js"(exports2, module2) {
    var sep = require("path").sep || "/";
    module2.exports = fileUriToPath;
    function fileUriToPath(uri) {
      if ("string" != typeof uri || uri.length <= 7 || "file://" != uri.substring(0, 7)) {
        throw new TypeError("must pass in a file:// URI to convert to a file path");
      }
      var rest = decodeURI(uri.substring(7));
      var firstSlash = rest.indexOf("/");
      var host = rest.substring(0, firstSlash);
      var path = rest.substring(firstSlash + 1);
      if ("localhost" == host)
        host = "";
      if (host) {
        host = sep + sep + host;
      }
      path = path.replace(/^(.+)\|/, "$1:");
      if (sep == "\\") {
        path = path.replace(/\//g, "\\");
      }
      if (/^.+\:/.test(path)) {
      } else {
        path = sep + path;
      }
      return host + path;
    }
  }
});

// node_modules/bindings/bindings.js
var require_bindings = __commonJS({
  "node_modules/bindings/bindings.js"(exports2, module2) {
    var fs = require("fs");
    var path = require("path");
    var fileURLToPath = require_file_uri_to_path();
    var join = path.join;
    var dirname = path.dirname;
    var exists = fs.accessSync && function(path2) {
      try {
        fs.accessSync(path2);
      } catch (e) {
        return false;
      }
      return true;
    } || fs.existsSync || path.existsSync;
    var defaults = {
      arrow: process.env.NODE_BINDINGS_ARROW || " \u2192 ",
      compiled: process.env.NODE_BINDINGS_COMPILED_DIR || "compiled",
      platform: process.platform,
      arch: process.arch,
      nodePreGyp: "node-v" + process.versions.modules + "-" + process.platform + "-" + process.arch,
      version: process.versions.node,
      bindings: "bindings.node",
      try: [
        // node-gyp's linked version in the "build" dir
        ["module_root", "build", "bindings"],
        // node-waf and gyp_addon (a.k.a node-gyp)
        ["module_root", "build", "Debug", "bindings"],
        ["module_root", "build", "Release", "bindings"],
        // Debug files, for development (legacy behavior, remove for node v0.9)
        ["module_root", "out", "Debug", "bindings"],
        ["module_root", "Debug", "bindings"],
        // Release files, but manually compiled (legacy behavior, remove for node v0.9)
        ["module_root", "out", "Release", "bindings"],
        ["module_root", "Release", "bindings"],
        // Legacy from node-waf, node <= 0.4.x
        ["module_root", "build", "default", "bindings"],
        // Production "Release" buildtype binary (meh...)
        ["module_root", "compiled", "version", "platform", "arch", "bindings"],
        // node-qbs builds
        ["module_root", "addon-build", "release", "install-root", "bindings"],
        ["module_root", "addon-build", "debug", "install-root", "bindings"],
        ["module_root", "addon-build", "default", "install-root", "bindings"],
        // node-pre-gyp path ./lib/binding/{node_abi}-{platform}-{arch}
        ["module_root", "lib", "binding", "nodePreGyp", "bindings"]
      ]
    };
    function bindings(opts) {
      if (typeof opts == "string") {
        opts = { bindings: opts };
      } else if (!opts) {
        opts = {};
      }
      Object.keys(defaults).map(function(i2) {
        if (!(i2 in opts))
          opts[i2] = defaults[i2];
      });
      if (!opts.module_root) {
        opts.module_root = exports2.getRoot(exports2.getFileName());
      }
      if (path.extname(opts.bindings) != ".node") {
        opts.bindings += ".node";
      }
      var requireFunc = typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;
      var tries = [], i = 0, l = opts.try.length, n, b, err;
      for (; i < l; i++) {
        n = join.apply(
          null,
          opts.try[i].map(function(p) {
            return opts[p] || p;
          })
        );
        tries.push(n);
        try {
          b = opts.path ? requireFunc.resolve(n) : requireFunc(n);
          if (!opts.path) {
            b.path = n;
          }
          return b;
        } catch (e) {
          if (e.code !== "MODULE_NOT_FOUND" && e.code !== "QUALIFIED_PATH_RESOLUTION_FAILED" && !/not find/i.test(e.message)) {
            throw e;
          }
        }
      }
      err = new Error(
        "Could not locate the bindings file. Tried:\n" + tries.map(function(a) {
          return opts.arrow + a;
        }).join("\n")
      );
      err.tries = tries;
      throw err;
    }
    module2.exports = exports2 = bindings;
    exports2.getFileName = function getFileName(calling_file) {
      var origPST = Error.prepareStackTrace, origSTL = Error.stackTraceLimit, dummy = {}, fileName;
      Error.stackTraceLimit = 10;
      Error.prepareStackTrace = function(e, st) {
        for (var i = 0, l = st.length; i < l; i++) {
          fileName = st[i].getFileName();
          if (fileName !== __filename) {
            if (calling_file) {
              if (fileName !== calling_file) {
                return;
              }
            } else {
              return;
            }
          }
        }
      };
      Error.captureStackTrace(dummy);
      dummy.stack;
      Error.prepareStackTrace = origPST;
      Error.stackTraceLimit = origSTL;
      var fileSchema = "file://";
      if (fileName.indexOf(fileSchema) === 0) {
        fileName = fileURLToPath(fileName);
      }
      return fileName;
    };
    exports2.getRoot = function getRoot(file) {
      var dir = dirname(file), prev;
      while (true) {
        if (dir === ".") {
          dir = process.cwd();
        }
        if (exists(join(dir, "package.json")) || exists(join(dir, "node_modules"))) {
          return dir;
        }
        if (prev === dir) {
          throw new Error(
            'Could not find module root given file: "' + file + '". Do you have a `package.json` file? '
          );
        }
        prev = dir;
        dir = join(dir, "..");
      }
    };
  }
});

// node_modules/better-sqlite3/lib/methods/wrappers.js
var require_wrappers = __commonJS({
  "node_modules/better-sqlite3/lib/methods/wrappers.js"(exports2) {
    "use strict";
    var { cppdb } = require_util();
    exports2.prepare = function prepare(sql) {
      return this[cppdb].prepare(sql, this, false);
    };
    exports2.exec = function exec(sql) {
      this[cppdb].exec(sql);
      return this;
    };
    exports2.close = function close() {
      this[cppdb].close();
      return this;
    };
    exports2.loadExtension = function loadExtension(...args) {
      this[cppdb].loadExtension(...args);
      return this;
    };
    exports2.defaultSafeIntegers = function defaultSafeIntegers(...args) {
      this[cppdb].defaultSafeIntegers(...args);
      return this;
    };
    exports2.unsafeMode = function unsafeMode(...args) {
      this[cppdb].unsafeMode(...args);
      return this;
    };
    exports2.getters = {
      name: {
        get: function name() {
          return this[cppdb].name;
        },
        enumerable: true
      },
      open: {
        get: function open() {
          return this[cppdb].open;
        },
        enumerable: true
      },
      inTransaction: {
        get: function inTransaction() {
          return this[cppdb].inTransaction;
        },
        enumerable: true
      },
      readonly: {
        get: function readonly() {
          return this[cppdb].readonly;
        },
        enumerable: true
      },
      memory: {
        get: function memory() {
          return this[cppdb].memory;
        },
        enumerable: true
      }
    };
  }
});

// node_modules/better-sqlite3/lib/methods/transaction.js
var require_transaction = __commonJS({
  "node_modules/better-sqlite3/lib/methods/transaction.js"(exports2, module2) {
    "use strict";
    var { cppdb } = require_util();
    var controllers = /* @__PURE__ */ new WeakMap();
    module2.exports = function transaction(fn) {
      if (typeof fn !== "function")
        throw new TypeError("Expected first argument to be a function");
      const db = this[cppdb];
      const controller = getController(db, this);
      const { apply } = Function.prototype;
      const properties = {
        default: { value: wrapTransaction(apply, fn, db, controller.default) },
        deferred: { value: wrapTransaction(apply, fn, db, controller.deferred) },
        immediate: { value: wrapTransaction(apply, fn, db, controller.immediate) },
        exclusive: { value: wrapTransaction(apply, fn, db, controller.exclusive) },
        database: { value: this, enumerable: true }
      };
      Object.defineProperties(properties.default.value, properties);
      Object.defineProperties(properties.deferred.value, properties);
      Object.defineProperties(properties.immediate.value, properties);
      Object.defineProperties(properties.exclusive.value, properties);
      return properties.default.value;
    };
    var getController = (db, self) => {
      let controller = controllers.get(db);
      if (!controller) {
        const shared = {
          commit: db.prepare("COMMIT", self, false),
          rollback: db.prepare("ROLLBACK", self, false),
          savepoint: db.prepare("SAVEPOINT `	_bs3.	`", self, false),
          release: db.prepare("RELEASE `	_bs3.	`", self, false),
          rollbackTo: db.prepare("ROLLBACK TO `	_bs3.	`", self, false)
        };
        controllers.set(db, controller = {
          default: Object.assign({ begin: db.prepare("BEGIN", self, false) }, shared),
          deferred: Object.assign({ begin: db.prepare("BEGIN DEFERRED", self, false) }, shared),
          immediate: Object.assign({ begin: db.prepare("BEGIN IMMEDIATE", self, false) }, shared),
          exclusive: Object.assign({ begin: db.prepare("BEGIN EXCLUSIVE", self, false) }, shared)
        });
      }
      return controller;
    };
    var wrapTransaction = (apply, fn, db, { begin, commit, rollback, savepoint, release, rollbackTo }) => function sqliteTransaction() {
      let before, after, undo;
      if (db.inTransaction) {
        before = savepoint;
        after = release;
        undo = rollbackTo;
      } else {
        before = begin;
        after = commit;
        undo = rollback;
      }
      before.run();
      try {
        const result = apply.call(fn, this, arguments);
        after.run();
        return result;
      } catch (ex) {
        if (db.inTransaction) {
          undo.run();
          if (undo !== rollback)
            after.run();
        }
        throw ex;
      }
    };
  }
});

// node_modules/better-sqlite3/lib/methods/pragma.js
var require_pragma = __commonJS({
  "node_modules/better-sqlite3/lib/methods/pragma.js"(exports2, module2) {
    "use strict";
    var { getBooleanOption, cppdb } = require_util();
    module2.exports = function pragma(source, options) {
      if (options == null)
        options = {};
      if (typeof source !== "string")
        throw new TypeError("Expected first argument to be a string");
      if (typeof options !== "object")
        throw new TypeError("Expected second argument to be an options object");
      const simple = getBooleanOption(options, "simple");
      const stmt = this[cppdb].prepare(`PRAGMA ${source}`, this, true);
      return simple ? stmt.pluck().get() : stmt.all();
    };
  }
});

// node_modules/better-sqlite3/lib/methods/backup.js
var require_backup = __commonJS({
  "node_modules/better-sqlite3/lib/methods/backup.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var { promisify } = require("util");
    var { cppdb } = require_util();
    var fsAccess = promisify(fs.access);
    module2.exports = async function backup(filename, options) {
      if (options == null)
        options = {};
      if (typeof filename !== "string")
        throw new TypeError("Expected first argument to be a string");
      if (typeof options !== "object")
        throw new TypeError("Expected second argument to be an options object");
      filename = filename.trim();
      const attachedName = "attached" in options ? options.attached : "main";
      const handler = "progress" in options ? options.progress : null;
      if (!filename)
        throw new TypeError("Backup filename cannot be an empty string");
      if (filename === ":memory:")
        throw new TypeError('Invalid backup filename ":memory:"');
      if (typeof attachedName !== "string")
        throw new TypeError('Expected the "attached" option to be a string');
      if (!attachedName)
        throw new TypeError('The "attached" option cannot be an empty string');
      if (handler != null && typeof handler !== "function")
        throw new TypeError('Expected the "progress" option to be a function');
      await fsAccess(path.dirname(filename)).catch(() => {
        throw new TypeError("Cannot save backup because the directory does not exist");
      });
      const isNewFile = await fsAccess(filename).then(() => false, () => true);
      return runBackup(this[cppdb].backup(this, attachedName, filename, isNewFile), handler || null);
    };
    var runBackup = (backup, handler) => {
      let rate = 0;
      let useDefault = true;
      return new Promise((resolve, reject) => {
        setImmediate(function step() {
          try {
            const progress = backup.transfer(rate);
            if (!progress.remainingPages) {
              backup.close();
              resolve(progress);
              return;
            }
            if (useDefault) {
              useDefault = false;
              rate = 100;
            }
            if (handler) {
              const ret = handler(progress);
              if (ret !== void 0) {
                if (typeof ret === "number" && ret === ret)
                  rate = Math.max(0, Math.min(2147483647, Math.round(ret)));
                else
                  throw new TypeError("Expected progress callback to return a number or undefined");
              }
            }
            setImmediate(step);
          } catch (err) {
            backup.close();
            reject(err);
          }
        });
      });
    };
  }
});

// node_modules/better-sqlite3/lib/methods/serialize.js
var require_serialize = __commonJS({
  "node_modules/better-sqlite3/lib/methods/serialize.js"(exports2, module2) {
    "use strict";
    var { cppdb } = require_util();
    module2.exports = function serialize(options) {
      if (options == null)
        options = {};
      if (typeof options !== "object")
        throw new TypeError("Expected first argument to be an options object");
      const attachedName = "attached" in options ? options.attached : "main";
      if (typeof attachedName !== "string")
        throw new TypeError('Expected the "attached" option to be a string');
      if (!attachedName)
        throw new TypeError('The "attached" option cannot be an empty string');
      return this[cppdb].serialize(attachedName);
    };
  }
});

// node_modules/better-sqlite3/lib/methods/function.js
var require_function = __commonJS({
  "node_modules/better-sqlite3/lib/methods/function.js"(exports2, module2) {
    "use strict";
    var { getBooleanOption, cppdb } = require_util();
    module2.exports = function defineFunction(name, options, fn) {
      if (options == null)
        options = {};
      if (typeof options === "function") {
        fn = options;
        options = {};
      }
      if (typeof name !== "string")
        throw new TypeError("Expected first argument to be a string");
      if (typeof fn !== "function")
        throw new TypeError("Expected last argument to be a function");
      if (typeof options !== "object")
        throw new TypeError("Expected second argument to be an options object");
      if (!name)
        throw new TypeError("User-defined function name cannot be an empty string");
      const safeIntegers = "safeIntegers" in options ? +getBooleanOption(options, "safeIntegers") : 2;
      const deterministic = getBooleanOption(options, "deterministic");
      const directOnly = getBooleanOption(options, "directOnly");
      const varargs = getBooleanOption(options, "varargs");
      let argCount = -1;
      if (!varargs) {
        argCount = fn.length;
        if (!Number.isInteger(argCount) || argCount < 0)
          throw new TypeError("Expected function.length to be a positive integer");
        if (argCount > 100)
          throw new RangeError("User-defined functions cannot have more than 100 arguments");
      }
      this[cppdb].function(fn, name, argCount, safeIntegers, deterministic, directOnly);
      return this;
    };
  }
});

// node_modules/better-sqlite3/lib/methods/aggregate.js
var require_aggregate = __commonJS({
  "node_modules/better-sqlite3/lib/methods/aggregate.js"(exports2, module2) {
    "use strict";
    var { getBooleanOption, cppdb } = require_util();
    module2.exports = function defineAggregate(name, options) {
      if (typeof name !== "string")
        throw new TypeError("Expected first argument to be a string");
      if (typeof options !== "object" || options === null)
        throw new TypeError("Expected second argument to be an options object");
      if (!name)
        throw new TypeError("User-defined function name cannot be an empty string");
      const start = "start" in options ? options.start : null;
      const step = getFunctionOption(options, "step", true);
      const inverse = getFunctionOption(options, "inverse", false);
      const result = getFunctionOption(options, "result", false);
      const safeIntegers = "safeIntegers" in options ? +getBooleanOption(options, "safeIntegers") : 2;
      const deterministic = getBooleanOption(options, "deterministic");
      const directOnly = getBooleanOption(options, "directOnly");
      const varargs = getBooleanOption(options, "varargs");
      let argCount = -1;
      if (!varargs) {
        argCount = Math.max(getLength(step), inverse ? getLength(inverse) : 0);
        if (argCount > 0)
          argCount -= 1;
        if (argCount > 100)
          throw new RangeError("User-defined functions cannot have more than 100 arguments");
      }
      this[cppdb].aggregate(start, step, inverse, result, name, argCount, safeIntegers, deterministic, directOnly);
      return this;
    };
    var getFunctionOption = (options, key, required) => {
      const value = key in options ? options[key] : null;
      if (typeof value === "function")
        return value;
      if (value != null)
        throw new TypeError(`Expected the "${key}" option to be a function`);
      if (required)
        throw new TypeError(`Missing required option "${key}"`);
      return null;
    };
    var getLength = ({ length }) => {
      if (Number.isInteger(length) && length >= 0)
        return length;
      throw new TypeError("Expected function.length to be a positive integer");
    };
  }
});

// node_modules/better-sqlite3/lib/methods/table.js
var require_table = __commonJS({
  "node_modules/better-sqlite3/lib/methods/table.js"(exports2, module2) {
    "use strict";
    var { cppdb } = require_util();
    module2.exports = function defineTable(name, factory) {
      if (typeof name !== "string")
        throw new TypeError("Expected first argument to be a string");
      if (!name)
        throw new TypeError("Virtual table module name cannot be an empty string");
      let eponymous = false;
      if (typeof factory === "object" && factory !== null) {
        eponymous = true;
        factory = defer(parseTableDefinition(factory, "used", name));
      } else {
        if (typeof factory !== "function")
          throw new TypeError("Expected second argument to be a function or a table definition object");
        factory = wrapFactory(factory);
      }
      this[cppdb].table(factory, name, eponymous);
      return this;
    };
    function wrapFactory(factory) {
      return function virtualTableFactory(moduleName, databaseName, tableName, ...args) {
        const thisObject = {
          module: moduleName,
          database: databaseName,
          table: tableName
        };
        const def = apply.call(factory, thisObject, args);
        if (typeof def !== "object" || def === null) {
          throw new TypeError(`Virtual table module "${moduleName}" did not return a table definition object`);
        }
        return parseTableDefinition(def, "returned", moduleName);
      };
    }
    function parseTableDefinition(def, verb, moduleName) {
      if (!hasOwnProperty.call(def, "rows")) {
        throw new TypeError(`Virtual table module "${moduleName}" ${verb} a table definition without a "rows" property`);
      }
      if (!hasOwnProperty.call(def, "columns")) {
        throw new TypeError(`Virtual table module "${moduleName}" ${verb} a table definition without a "columns" property`);
      }
      const rows = def.rows;
      if (typeof rows !== "function" || Object.getPrototypeOf(rows) !== GeneratorFunctionPrototype) {
        throw new TypeError(`Virtual table module "${moduleName}" ${verb} a table definition with an invalid "rows" property (should be a generator function)`);
      }
      let columns = def.columns;
      if (!Array.isArray(columns) || !(columns = [...columns]).every((x) => typeof x === "string")) {
        throw new TypeError(`Virtual table module "${moduleName}" ${verb} a table definition with an invalid "columns" property (should be an array of strings)`);
      }
      if (columns.length !== new Set(columns).size) {
        throw new TypeError(`Virtual table module "${moduleName}" ${verb} a table definition with duplicate column names`);
      }
      if (!columns.length) {
        throw new RangeError(`Virtual table module "${moduleName}" ${verb} a table definition with zero columns`);
      }
      let parameters;
      if (hasOwnProperty.call(def, "parameters")) {
        parameters = def.parameters;
        if (!Array.isArray(parameters) || !(parameters = [...parameters]).every((x) => typeof x === "string")) {
          throw new TypeError(`Virtual table module "${moduleName}" ${verb} a table definition with an invalid "parameters" property (should be an array of strings)`);
        }
      } else {
        parameters = inferParameters(rows);
      }
      if (parameters.length !== new Set(parameters).size) {
        throw new TypeError(`Virtual table module "${moduleName}" ${verb} a table definition with duplicate parameter names`);
      }
      if (parameters.length > 32) {
        throw new RangeError(`Virtual table module "${moduleName}" ${verb} a table definition with more than the maximum number of 32 parameters`);
      }
      for (const parameter of parameters) {
        if (columns.includes(parameter)) {
          throw new TypeError(`Virtual table module "${moduleName}" ${verb} a table definition with column "${parameter}" which was ambiguously defined as both a column and parameter`);
        }
      }
      let safeIntegers = 2;
      if (hasOwnProperty.call(def, "safeIntegers")) {
        const bool = def.safeIntegers;
        if (typeof bool !== "boolean") {
          throw new TypeError(`Virtual table module "${moduleName}" ${verb} a table definition with an invalid "safeIntegers" property (should be a boolean)`);
        }
        safeIntegers = +bool;
      }
      let directOnly = false;
      if (hasOwnProperty.call(def, "directOnly")) {
        directOnly = def.directOnly;
        if (typeof directOnly !== "boolean") {
          throw new TypeError(`Virtual table module "${moduleName}" ${verb} a table definition with an invalid "directOnly" property (should be a boolean)`);
        }
      }
      const columnDefinitions = [
        ...parameters.map(identifier).map((str) => `${str} HIDDEN`),
        ...columns.map(identifier)
      ];
      return [
        `CREATE TABLE x(${columnDefinitions.join(", ")});`,
        wrapGenerator(rows, new Map(columns.map((x, i) => [x, parameters.length + i])), moduleName),
        parameters,
        safeIntegers,
        directOnly
      ];
    }
    function wrapGenerator(generator, columnMap, moduleName) {
      return function* virtualTable(...args) {
        const output = args.map((x) => Buffer.isBuffer(x) ? Buffer.from(x) : x);
        for (let i = 0; i < columnMap.size; ++i) {
          output.push(null);
        }
        for (const row of generator(...args)) {
          if (Array.isArray(row)) {
            extractRowArray(row, output, columnMap.size, moduleName);
            yield output;
          } else if (typeof row === "object" && row !== null) {
            extractRowObject(row, output, columnMap, moduleName);
            yield output;
          } else {
            throw new TypeError(`Virtual table module "${moduleName}" yielded something that isn't a valid row object`);
          }
        }
      };
    }
    function extractRowArray(row, output, columnCount, moduleName) {
      if (row.length !== columnCount) {
        throw new TypeError(`Virtual table module "${moduleName}" yielded a row with an incorrect number of columns`);
      }
      const offset = output.length - columnCount;
      for (let i = 0; i < columnCount; ++i) {
        output[i + offset] = row[i];
      }
    }
    function extractRowObject(row, output, columnMap, moduleName) {
      let count = 0;
      for (const key of Object.keys(row)) {
        const index = columnMap.get(key);
        if (index === void 0) {
          throw new TypeError(`Virtual table module "${moduleName}" yielded a row with an undeclared column "${key}"`);
        }
        output[index] = row[key];
        count += 1;
      }
      if (count !== columnMap.size) {
        throw new TypeError(`Virtual table module "${moduleName}" yielded a row with missing columns`);
      }
    }
    function inferParameters({ length }) {
      if (!Number.isInteger(length) || length < 0) {
        throw new TypeError("Expected function.length to be a positive integer");
      }
      const params = [];
      for (let i = 0; i < length; ++i) {
        params.push(`$${i + 1}`);
      }
      return params;
    }
    var { hasOwnProperty } = Object.prototype;
    var { apply } = Function.prototype;
    var GeneratorFunctionPrototype = Object.getPrototypeOf(function* () {
    });
    var identifier = (str) => `"${str.replace(/"/g, '""')}"`;
    var defer = (x) => () => x;
  }
});

// node_modules/better-sqlite3/lib/methods/inspect.js
var require_inspect = __commonJS({
  "node_modules/better-sqlite3/lib/methods/inspect.js"(exports2, module2) {
    "use strict";
    var DatabaseInspection = function Database() {
    };
    module2.exports = function inspect(depth, opts) {
      return Object.assign(new DatabaseInspection(), this);
    };
  }
});

// node_modules/better-sqlite3/lib/database.js
var require_database = __commonJS({
  "node_modules/better-sqlite3/lib/database.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var util = require_util();
    var SqliteError = require_sqlite_error();
    var DEFAULT_ADDON;
    function Database(filenameGiven, options) {
      if (new.target == null) {
        return new Database(filenameGiven, options);
      }
      let buffer;
      if (Buffer.isBuffer(filenameGiven)) {
        buffer = filenameGiven;
        filenameGiven = ":memory:";
      }
      if (filenameGiven == null)
        filenameGiven = "";
      if (options == null)
        options = {};
      if (typeof filenameGiven !== "string")
        throw new TypeError("Expected first argument to be a string");
      if (typeof options !== "object")
        throw new TypeError("Expected second argument to be an options object");
      if ("readOnly" in options)
        throw new TypeError('Misspelled option "readOnly" should be "readonly"');
      if ("memory" in options)
        throw new TypeError('Option "memory" was removed in v7.0.0 (use ":memory:" filename instead)');
      const filename = filenameGiven.trim();
      const anonymous = filename === "" || filename === ":memory:";
      const readonly = util.getBooleanOption(options, "readonly");
      const fileMustExist = util.getBooleanOption(options, "fileMustExist");
      const timeout = "timeout" in options ? options.timeout : 5e3;
      const verbose = "verbose" in options ? options.verbose : null;
      const nativeBinding = "nativeBinding" in options ? options.nativeBinding : null;
      if (readonly && anonymous && !buffer)
        throw new TypeError("In-memory/temporary databases cannot be readonly");
      if (!Number.isInteger(timeout) || timeout < 0)
        throw new TypeError('Expected the "timeout" option to be a positive integer');
      if (timeout > 2147483647)
        throw new RangeError('Option "timeout" cannot be greater than 2147483647');
      if (verbose != null && typeof verbose !== "function")
        throw new TypeError('Expected the "verbose" option to be a function');
      if (nativeBinding != null && typeof nativeBinding !== "string" && typeof nativeBinding !== "object")
        throw new TypeError('Expected the "nativeBinding" option to be a string or addon object');
      let addon;
      if (nativeBinding == null) {
        addon = DEFAULT_ADDON || (DEFAULT_ADDON = require_bindings()("better_sqlite3.node"));
      } else if (typeof nativeBinding === "string") {
        const requireFunc = typeof __non_webpack_require__ === "function" ? __non_webpack_require__ : require;
        addon = requireFunc(path.resolve(nativeBinding).replace(/(\.node)?$/, ".node"));
      } else {
        addon = nativeBinding;
      }
      if (!addon.isInitialized) {
        addon.setErrorConstructor(SqliteError);
        addon.isInitialized = true;
      }
      if (!anonymous && !fs.existsSync(path.dirname(filename))) {
        throw new TypeError("Cannot open database because the directory does not exist");
      }
      Object.defineProperties(this, {
        [util.cppdb]: { value: new addon.Database(filename, filenameGiven, anonymous, readonly, fileMustExist, timeout, verbose || null, buffer || null) },
        ...wrappers.getters
      });
    }
    var wrappers = require_wrappers();
    Database.prototype.prepare = wrappers.prepare;
    Database.prototype.transaction = require_transaction();
    Database.prototype.pragma = require_pragma();
    Database.prototype.backup = require_backup();
    Database.prototype.serialize = require_serialize();
    Database.prototype.function = require_function();
    Database.prototype.aggregate = require_aggregate();
    Database.prototype.table = require_table();
    Database.prototype.loadExtension = wrappers.loadExtension;
    Database.prototype.exec = wrappers.exec;
    Database.prototype.close = wrappers.close;
    Database.prototype.defaultSafeIntegers = wrappers.defaultSafeIntegers;
    Database.prototype.unsafeMode = wrappers.unsafeMode;
    Database.prototype[util.inspect] = require_inspect();
    module2.exports = Database;
  }
});

// node_modules/better-sqlite3/lib/index.js
var require_lib = __commonJS({
  "node_modules/better-sqlite3/lib/index.js"(exports2, module2) {
    "use strict";
    module2.exports = require_database();
    module2.exports.SqliteError = require_sqlite_error();
  }
});

// database-handler.js
var require_database_handler = __commonJS({
  "database-handler.js"(exports2, module2) {
    "use strict";
    var Database = require_lib();
    var DatabaseHandler2 = class {
      constructor(databaseUrl) {
        this.databaseUrl = databaseUrl;
        this.db = null;
      }
      /**
       * Connect to database
       */
      async connect() {
        const dbPath = this.databaseUrl.replace("sqlite:", "");
        if (!dbPath) {
          throw new Error("Database path not provided");
        }
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        console.log("[DB] Connected to:", dbPath);
      }
      /**
       * Disconnect from database
       */
      async disconnect() {
        if (this.db) {
          this.db.close();
          this.db = null;
          console.log("[DB] Disconnected");
        }
      }
      /**
       * Get session by ID
       */
      getSession(sessionId) {
        return this.db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `).get(sessionId);
      }
      /**
       * Update session status
       */
      updateSessionStatus(sessionId, status) {
        return this.db.prepare(`
      UPDATE sessions
      SET status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, sessionId);
      }
      /**
       * Update session context
       */
      updateSessionContext(sessionId, tokenCount, isCompacting) {
        return this.db.prepare(`
      UPDATE sessions
      SET context_token_count = ?,
          is_compacting = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(tokenCount, isCompacting ? 1 : 0, sessionId);
      }
      /**
       * Insert message
       */
      insertMessage(messageData) {
        const {
          id,
          session_id,
          role,
          content,
          model,
          sdk_message_id,
          last_assistant_message_id,
          sent_at,
          tool_uses
        } = messageData;
        return this.db.prepare(`
      INSERT INTO session_messages (
        id, session_id, role, content, model,
        sdk_message_id, last_assistant_message_id,
        sent_at, tool_uses, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
          id,
          session_id,
          role,
          content,
          model || "sonnet",
          sdk_message_id,
          last_assistant_message_id,
          sent_at,
          tool_uses ? JSON.stringify(tool_uses) : null
        );
      }
      /**
       * Update message with SDK ID
       */
      updateMessageSdkId(messageId, sdkMessageId) {
        return this.db.prepare(`
      UPDATE session_messages
      SET sdk_message_id = ?
      WHERE id = ?
    `).run(sdkMessageId, messageId);
      }
      /**
       * Mark messages as read
       */
      markMessagesAsRead(sessionId) {
        return this.db.prepare(`
      UPDATE session_messages
      SET is_read = 1
      WHERE session_id = ? AND is_read = 0
    `).run(sessionId);
      }
      /**
       * Execute custom query
       */
      query(sql, params = []) {
        return this.db.prepare(sql).all(...params);
      }
      /**
       * Execute custom statement
       */
      exec(sql, params = []) {
        return this.db.prepare(sql).run(...params);
      }
    };
    module2.exports = { DatabaseHandler: DatabaseHandler2 };
  }
});

// claude-manager.js
var require_claude_manager = __commonJS({
  "claude-manager.js"(exports2, module2) {
    "use strict";
    var { spawn } = require("child_process");
    var { randomUUID } = require("crypto");
    var ClaudeManager2 = class {
      constructor(dbHandler) {
        this.dbHandler = dbHandler;
        this.sessions = /* @__PURE__ */ new Map();
      }
      /**
       * Start a new Claude CLI session
       */
      async startSession(data) {
        const { sessionId, workspacePath } = data;
        if (this.sessions.has(sessionId)) {
          console.log(`[CLAUDE] Session ${sessionId} already running`);
          return { success: true, message: "Session already running" };
        }
        try {
          console.log(`[CLAUDE] Starting session ${sessionId} in ${workspacePath}`);
          const claudeProcess = spawn("claude", [], {
            cwd: workspacePath,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...process.env,
              CLAUDE_CLI_SESSION_ID: sessionId
            }
          });
          this.sessions.set(sessionId, {
            process: claudeProcess,
            workspacePath
          });
          this.setupProcessHandlers(sessionId, claudeProcess);
          this.dbHandler.updateSessionStatus(sessionId, "working");
          return { success: true, sessionId };
        } catch (error) {
          console.error(`[CLAUDE] Error starting session:`, error);
          return { success: false, error: error.message };
        }
      }
      /**
       * Setup handlers for Claude process
       */
      setupProcessHandlers(sessionId, claudeProcess) {
        let outputBuffer = "";
        claudeProcess.stdout.on("data", (data) => {
          outputBuffer += data.toString();
          const messages = this.parseClaudeOutput(outputBuffer);
          for (const message of messages) {
            this.handleClaudeMessage(sessionId, message);
          }
        });
        claudeProcess.stderr.on("data", (data) => {
          console.error(`[CLAUDE] stderr:`, data.toString());
        });
        claudeProcess.on("exit", (code, signal) => {
          console.log(`[CLAUDE] Session ${sessionId} exited (code: ${code}, signal: ${signal})`);
          this.sessions.delete(sessionId);
          this.dbHandler.updateSessionStatus(sessionId, "idle");
        });
        claudeProcess.on("error", (error) => {
          console.error(`[CLAUDE] Process error:`, error);
          this.sessions.delete(sessionId);
          this.dbHandler.updateSessionStatus(sessionId, "error");
        });
      }
      /**
       * Parse Claude SDK output
       */
      parseClaudeOutput(output) {
        const messages = [];
        const lines = output.split("\n");
        for (const line of lines) {
          if (line.trim().startsWith("{")) {
            try {
              const message = JSON.parse(line);
              messages.push(message);
            } catch (error) {
            }
          }
        }
        return messages;
      }
      /**
       * Handle message from Claude SDK
       */
      handleClaudeMessage(sessionId, message) {
        try {
          const { type, data } = message;
          switch (type) {
            case "message":
              this.handleAssistantMessage(sessionId, data);
              break;
            case "context_update":
              this.handleContextUpdate(sessionId, data);
              break;
            case "error":
              console.error(`[CLAUDE] Error from SDK:`, data);
              break;
            default:
              console.log(`[CLAUDE] Unknown message type: ${type}`);
          }
        } catch (error) {
          console.error("[CLAUDE] Error handling message:", error);
        }
      }
      /**
       * Handle assistant message from Claude
       */
      handleAssistantMessage(sessionId, data) {
        const messageId = randomUUID();
        const { content, sdk_message_id, tool_uses } = data;
        this.dbHandler.insertMessage({
          id: messageId,
          session_id: sessionId,
          role: "assistant",
          content: content || "",
          model: "sonnet",
          sdk_message_id,
          last_assistant_message_id: null,
          sent_at: (/* @__PURE__ */ new Date()).toISOString(),
          tool_uses
        });
        console.log(`[CLAUDE] Saved assistant message for session ${sessionId}`);
      }
      /**
       * Handle context update from Claude SDK
       */
      handleContextUpdate(sessionId, data) {
        const { token_count, is_compacting } = data;
        this.dbHandler.updateSessionContext(
          sessionId,
          token_count,
          is_compacting || false
        );
        console.log(`[CLAUDE] Context updated: ${token_count} tokens`);
      }
      /**
       * Send message to Claude CLI
       */
      async sendMessage(data) {
        const { sessionId, content } = data;
        const session = this.sessions.get(sessionId);
        if (!session) {
          return { success: false, error: "Session not found" };
        }
        try {
          session.process.stdin.write(content + "\n");
          return { success: true };
        } catch (error) {
          console.error("[CLAUDE] Error sending message:", error);
          return { success: false, error: error.message };
        }
      }
      /**
       * Stop a Claude CLI session
       */
      async stopSession(data) {
        const { sessionId } = data;
        const session = this.sessions.get(sessionId);
        if (!session) {
          return { success: true, message: "Session not running" };
        }
        try {
          session.process.kill("SIGTERM");
          this.sessions.delete(sessionId);
          return { success: true };
        } catch (error) {
          console.error("[CLAUDE] Error stopping session:", error);
          return { success: false, error: error.message };
        }
      }
      /**
       * Stop all sessions
       */
      async stopAll() {
        console.log(`[CLAUDE] Stopping all ${this.sessions.size} sessions...`);
        for (const [sessionId, session] of this.sessions) {
          try {
            session.process.kill("SIGTERM");
          } catch (error) {
            console.error(`[CLAUDE] Error stopping session ${sessionId}:`, error);
          }
        }
        this.sessions.clear();
      }
      /**
       * Get status of all sessions
       */
      getStatus() {
        const sessions = [];
        for (const [sessionId, session] of this.sessions) {
          sessions.push({
            sessionId,
            workspacePath: session.workspacePath,
            pid: session.process.pid
          });
        }
        return {
          active_sessions: sessions.length,
          sessions
        };
      }
    };
    module2.exports = { ClaudeManager: ClaudeManager2 };
  }
});

// keepalive.js
var require_keepalive = __commonJS({
  "keepalive.js"(exports2, module2) {
    "use strict";
    function startKeepalive2(socketServer, interval) {
      console.log(`[KEEPALIVE] Starting with ${interval}ms interval`);
      return setInterval(() => {
        socketServer.broadcast({
          type: "keep_alive",
          timestamp: Date.now()
        });
      }, interval);
    }
    module2.exports = { startKeepalive: startKeepalive2 };
  }
});

// index.js
var { SocketServer } = require_socket_server();
var { DatabaseHandler } = require_database_handler();
var { ClaudeManager } = require_claude_manager();
var { startKeepalive } = require_keepalive();
var CONFIG = {
  KEEPALIVE_INTERVAL: 3e4,
  // 30 seconds
  SOCKET_TIMEOUT: 6e4,
  // 60 seconds
  DATABASE_URL: process.env.DATABASE_URL || ""
};
var SidecarApp = class {
  constructor() {
    this.socketServer = null;
    this.dbHandler = null;
    this.claudeManager = null;
    this.keepaliveInterval = null;
  }
  /**
   * Initialize all components
   */
  async initialize() {
    try {
      console.log("[SIDECAR] \u{1F680} Starting Conductor Sidecar...");
      this.dbHandler = new DatabaseHandler(CONFIG.DATABASE_URL);
      await this.dbHandler.connect();
      console.log("[SIDECAR] \u2705 Database connected");
      this.claudeManager = new ClaudeManager(this.dbHandler);
      console.log("[SIDECAR] \u2705 Claude manager initialized");
      this.socketServer = new SocketServer(this.handleMessage.bind(this));
      await this.socketServer.start();
      console.log("[SIDECAR] \u2705 Socket server started");
      console.log(`SOCKET_PATH=${this.socketServer.getSocketPath()}`);
      this.keepaliveInterval = startKeepalive(
        this.socketServer,
        CONFIG.KEEPALIVE_INTERVAL
      );
      console.log("[SIDECAR] \u2705 Keepalive started");
      console.log("[SIDECAR] \u2705 Sidecar ready!");
    } catch (error) {
      console.error("[SIDECAR] \u274C Initialization failed:", error);
      process.exit(1);
    }
  }
  /**
   * Handle incoming messages from backend
   */
  async handleMessage(message) {
    try {
      const { command, data } = message;
      switch (command) {
        case "start_session":
          return await this.claudeManager.startSession(data);
        case "send_message":
          return await this.claudeManager.sendMessage(data);
        case "stop_session":
          return await this.claudeManager.stopSession(data);
        case "get_status":
          return this.claudeManager.getStatus();
        default:
          console.warn(`[SIDECAR] Unknown command: ${command}`);
          return { error: "Unknown command" };
      }
    } catch (error) {
      console.error("[SIDECAR] Error handling message:", error);
      return { error: error.message };
    }
  }
  /**
   * Graceful shutdown
   */
  async shutdown() {
    console.log("[SIDECAR] \u{1F6D1} Shutting down...");
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
    }
    if (this.claudeManager) {
      await this.claudeManager.stopAll();
    }
    if (this.socketServer) {
      await this.socketServer.stop();
    }
    if (this.dbHandler) {
      await this.dbHandler.disconnect();
    }
    console.log("[SIDECAR] \u2705 Shutdown complete");
    process.exit(0);
  }
};
var app = new SidecarApp();
process.on("SIGTERM", () => app.shutdown());
process.on("SIGINT", () => app.shutdown());
app.initialize().catch((error) => {
  console.error("[SIDECAR] \u274C Fatal error:", error);
  process.exit(1);
});
