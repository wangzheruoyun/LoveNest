/**
 * gc-bridge.js — nw.js / Node compatibility shim for the Love Nest Android port.
 *
 * The engine (GameCreator 2 / LayaAir, an ES5-era NW.js build) boots from a
 * `file://` URL inside an Android WebView and expects the NW.js renderer
 * environment: `window.require`, `window.process`, and the Node core modules
 * it happens to use. This file supplies that environment and lands every
 * native capability on the `__GCNative` host object (see the plan's Task 3
 * Interfaces; on Android it is `GameBridge.kt`, headless it is
 * `tools/headless/host-native.js`).
 *
 * Hard project constraints:
 *   - ES5 syntax only (`var` / `function`; no arrow functions, no `let`/`const`,
 *     no template literals, no classes). Runtime built-ins such as `Proxy` and
 *     `Uint8Array` may be *used*, guarded where they might be absent.
 *   - `path` is deliberately POSIX even though `process.platform` reports
 *     `'win32'`: the host filesystem on Android is POSIX, so forward slashes
 *     are what the host expects. The win32 value only steers the engine into
 *     its PC code paths (Meta performances, `fs` saves).
 *   - The host is the single authority for path resolution and escape
 *     rejection (plan Ruling 1). `resolvePath()` below only does Node-style
 *     joining; it never performs an escape check of its own.
 *
 * This script is prepended to `script.js` before the engine runs, so it must
 * attach everything the engine needs to the global `window` and must not
 * shadow engine globals (the engine has its own `os` object, for instance).
 */
(function () {
  'use strict';

  // The engine is prepended-injected into a page, so `window` always exists.
  // Fall back to `globalThis`/`self` only to keep the file loadable in exotic
  // hosts (node:vm tests, workers).
  var win = null;
  if (typeof window !== 'undefined') win = window;
  else if (typeof globalThis !== 'undefined') win = globalThis;
  else if (typeof self !== 'undefined') win = self;

  // The native host. On Android MainActivity points `window.__GCNative` at the
  // `@JavascriptInterface` object; the headless harness injects a plain object.
  var host = null;
  if (win && win.__GCNative) host = win.__GCNative;
  else if (typeof __GCNative !== 'undefined') host = __GCNative;

  /* ------------------------------------------------------------------ *
   * Native host helpers
   * ------------------------------------------------------------------ */

  function gameRoot() {
    if (host && typeof host.gameRoot === 'function') {
      return String(host.gameRoot());
    }
    return '/';
  }

  function docsRoot() {
    if (host && typeof host.docsRoot === 'function') {
      return String(host.docsRoot());
    }
    return '/';
  }

  /* ------------------------------------------------------------------ *
   * POSIX `path` shim
   *
   * A faithful port of Node's `path.posix` primitives (normalize, join,
   * resolve, isAbsolute, dirname, basename, extname). Pure string work, no
   * host access. The engine calls join/resolve/isAbsolute/dirname/basename/
   * extname; normalize is used by the bundled module loader.
   * ------------------------------------------------------------------ */

  var CHAR_DOT = 46;
  var CHAR_SLASH = 47;

  /**
   * Collapse `.` / `..` segments and duplicate separators.
   * `allowAboveRoot` keeps leading `..` segments (used for relative paths).
   */
  function normalizeString(p, allowAboveRoot) {
    var res = '';
    var lastSegmentLength = 0;
    var lastSlash = -1;
    var dots = 0;
    var code = 0;
    for (var i = 0; i <= p.length; ++i) {
      if (i < p.length) code = p.charCodeAt(i);
      else if (code === CHAR_SLASH) break;
      else code = CHAR_SLASH;

      if (code === CHAR_SLASH) {
        if (lastSlash === i - 1 || dots === 1) {
          // Empty segment, or a lone `.`: drop it.
        } else if (dots === 2) {
          if (res.length < 2 || lastSegmentLength !== 2 ||
            res.charCodeAt(res.length - 1) !== CHAR_DOT ||
            res.charCodeAt(res.length - 2) !== CHAR_DOT) {
            if (res.length > 2) {
              var lastSlashIndex = res.lastIndexOf('/');
              if (lastSlashIndex === -1) {
                res = '';
                lastSegmentLength = 0;
              } else {
                res = res.slice(0, lastSlashIndex);
                lastSegmentLength = res.length - 1 - res.lastIndexOf('/');
              }
            } else if (res.length !== 0) {
              res = '';
              lastSegmentLength = 0;
            } else if (allowAboveRoot) {
              res = '..';
              lastSegmentLength = 2;
            }
          } else {
            if (res.length > 0) res += '/' + p.slice(lastSlash + 1, i);
            else res = p.slice(lastSlash + 1, i);
            lastSegmentLength = i - lastSlash - 1;
          }
        } else {
          if (res.length > 0) res += '/' + p.slice(lastSlash + 1, i);
          else res = p.slice(lastSlash + 1, i);
          lastSegmentLength = i - lastSlash - 1;
        }
        lastSlash = i;
        dots = 0;
      } else if (code === CHAR_DOT && dots !== -1) {
        ++dots;
      } else {
        dots = -1;
      }
    }
    return res;
  }

  function normalize(p) {
    p = String(p == null ? '' : p);
    if (p.length === 0) return '.';
    var isAbsolute = p.charCodeAt(0) === CHAR_SLASH;
    var trailingSeparator = p.charCodeAt(p.length - 1) === CHAR_SLASH;
    p = normalizeString(p, !isAbsolute);
    if (p.length === 0) {
      if (isAbsolute) return '/';
      return trailingSeparator ? './' : '.';
    }
    if (trailingSeparator) p += '/';
    return isAbsolute ? '/' + p : p;
  }

  function join() {
    var joined;
    for (var i = 0; i < arguments.length; i++) {
      var arg = arguments[i];
      if (arg === undefined || arg === null || arg === '') continue;
      arg = String(arg);
      if (joined === undefined) joined = arg;
      else joined += '/' + arg;
    }
    if (joined === undefined) return '.';
    return normalize(joined);
  }

  function resolve() {
    var tail = [];
    var resolved = false;
    var i, arg;
    for (i = arguments.length - 1; i >= 0; i--) {
      arg = arguments[i];
      if (arg === undefined || arg === null || arg === '') continue;
      arg = String(arg);
      tail.unshift(arg);
      if (arg.charAt(0) === '/') {
        resolved = true;
        break;
      }
    }
    if (!resolved) tail.unshift(processObject.cwd());
    var out = normalize(tail.join('/'));
    if (out.length > 1 && out.charAt(out.length - 1) === '/') {
      out = out.slice(0, -1);
    }
    return out;
  }

  function isAbsolute(p) {
    return typeof p === 'string' && p.charAt(0) === '/';
  }

  function dirname(p) {
    p = String(p == null ? '' : p);
    if (p.length === 0) return '.';
    var hasRoot = p.charCodeAt(0) === CHAR_SLASH;
    var end = -1;
    var matchedSlash = true;
    for (var i = p.length - 1; i >= 1; --i) {
      if (p.charCodeAt(i) === CHAR_SLASH) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        matchedSlash = false;
      }
    }
    if (end === -1) return hasRoot ? '/' : '.';
    if (hasRoot && end === 1) return '//';
    return p.slice(0, end);
  }

  function basename(p, ext) {
    p = String(p == null ? '' : p);
    var start = 0;
    var end = -1;
    var matchedSlash = true;
    var i;
    if (ext !== undefined && ext.length > 0 && ext.length <= p.length) {
      if (ext.length === p.length && ext === p) return '';
      var extIdx = ext.length - 1;
      var firstNonSlashEnd = -1;
      for (i = p.length - 1; i >= 0; --i) {
        var code = p.charCodeAt(i);
        if (code === CHAR_SLASH) {
          if (!matchedSlash) {
            start = i + 1;
            break;
          }
        } else {
          if (firstNonSlashEnd === -1) {
            matchedSlash = false;
            firstNonSlashEnd = i + 1;
          }
          if (extIdx >= 0) {
            if (code === ext.charCodeAt(extIdx)) {
              if (--extIdx === -1) end = i;
            } else {
              extIdx = -1;
              end = firstNonSlashEnd;
            }
          }
        }
      }
      if (start === end) end = firstNonSlashEnd;
      else if (end === -1) end = p.length;
      return p.slice(start, end);
    }
    for (i = p.length - 1; i >= 0; --i) {
      if (p.charCodeAt(i) === CHAR_SLASH) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
    }
    if (end === -1) return '';
    return p.slice(start, end);
  }

  function extname(p) {
    p = String(p == null ? '' : p);
    var startDot = -1;
    var startPart = 0;
    var end = -1;
    var matchedSlash = true;
    // Track the state of characters (if any) we see before our first dot and
    // after any path separator we find.
    var preDotState = 0;
    for (var i = p.length - 1; i >= 0; --i) {
      var code = p.charCodeAt(i);
      if (code === CHAR_SLASH) {
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
      if (code === CHAR_DOT) {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }
    if (startDot === -1 || end === -1 ||
      preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
      return '';
    }
    return p.slice(startDot, end);
  }

  var pathModule = {
    normalize: normalize,
    join: join,
    resolve: resolve,
    isAbsolute: isAbsolute,
    dirname: dirname,
    basename: basename,
    extname: extname,
    sep: '/',
    delimiter: ':'
  };

  /* ------------------------------------------------------------------ *
   * `os` shim
   * ------------------------------------------------------------------ */

  // Only the members the engine actually calls are provided: homedir (save
  // path), and userInfo/hostname/type/release/arch (the Meta "system info"
  // and real-user-name performances).
  var osModule = {
    homedir: function () {
      return docsRoot();
    },
    hostname: function () {
      return (host && typeof host.deviceName === 'function') ? String(host.deviceName()) : '';
    },
    userInfo: function () {
      return {
        username: osModule.hostname(),
        uid: -1,
        gid: -1,
        shell: null,
        homedir: docsRoot()
      };
    },
    type: function () {
      return 'Android';
    },
    release: function () {
      return (host && typeof host.androidVersion === 'function') ? String(host.androidVersion()) : '';
    },
    arch: function () {
      return 'arm64';
    },
    // The engine divides these by a unit to render a GB figure. As with
    // memoryUsage(), a browser cannot report real system memory, so return
    // stable non-zero byte counts rather than let the arithmetic produce NaN.
    totalmem: function () {
      return 6442450944; // 6 GiB
    },
    freemem: function () {
      return 3221225472; // 3 GiB
    }
  };

  /* ------------------------------------------------------------------ *
   * `process` shim
   * ------------------------------------------------------------------ */

  // The engine reads memoryUsage() only to show a number, and it sums
  // rss + heapTotal + external. A browser cannot expose the NW.js heap, so
  // report a stable non-zero shape rather than break that arithmetic.
  var processObject = {
    platform: 'win32',
    versions: { node: '0.64.1' },
    argv: [],
    env: {},
    cwd: function () {
      return gameRoot();
    },
    memoryUsage: function () {
      return {
        rss: 33554432,
        heapTotal: 16777216,
        heapUsed: 8388608,
        external: 1048576
      };
    },
    // The engine registers `uncaughtException` / `unhandledRejection` hooks.
    // They are a no-op here: swallowing errors would hide real page errors
    // from the headless acceptance run (plan Task 5).
    on: function () {
      return processObject;
    },
    nextTick: function (fn) {
      var args = Array.prototype.slice.call(arguments, 1);
      setTimeout(function () {
        if (typeof fn === 'function') fn.apply(null, args);
      }, 0);
    },
    // Forwarded to the `child_process` module (implemented in a later step).
    exec: function () {
      var cp = requireModule('child_process');
      return cp.exec.apply(cp, arguments);
    },
    execSync: function () {
      var cp = requireModule('child_process');
      return cp.execSync.apply(cp, arguments);
    }
  };

  /* ------------------------------------------------------------------ *
   * Base64 helper (used by the `fs` shim)
   * ------------------------------------------------------------------ */

  var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /**
   * Decode a base64 string to a `Uint8Array`. Tolerates data: URLs, URL-safe
   * alphabet and whitespace; never throws.
   */
  function toBuffer(b64) {
    var s = String(b64 == null ? '' : b64);
    if (s.slice(0, 5) === 'data:') {
      var comma = s.indexOf(',');
      if (comma >= 0) s = s.slice(comma + 1);
    }
    s = s.replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
    var pad = s.indexOf('=');
    if (pad >= 0) s = s.slice(0, pad);

    var bytes = new Uint8Array(Math.floor(s.length * 3 / 4));
    var out = 0;
    var acc = 0;
    var bits = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64_ALPHABET.indexOf(s.charAt(i));
      if (v < 0) continue;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes[out++] = (acc >> bits) & 0xff;
      }
    }
    if (out === bytes.length) return bytes;
    var trimmed = new Uint8Array(out);
    for (var j = 0; j < out; j++) trimmed[j] = bytes[j];
    return trimmed;
  }

  /* ------------------------------------------------------------------ *
   * Path resolution used by the file / command shims
   * ------------------------------------------------------------------ */

  /**
   * Turn a caller-supplied path into a host-absolute path. Absolute paths are
   * normalised; relative paths are joined against the game root exactly the
   * way Node joins against `process.cwd()`.
   *
   * No escape check lives here on purpose: the host owns that decision
   * (plan Ruling 1).
   */
  function resolvePath(p) {
    var s = (typeof p === 'string') ? p : String(p == null ? '' : p);
    if (s === '') return processObject.cwd();
    if (s.charAt(0) === '/') return normalize(s);
    return join(processObject.cwd(), s);
  }

  /* ------------------------------------------------------------------ *
   * `require` with a lazy no-op fallback
   * ------------------------------------------------------------------ */

  /**
   * A lazy no-op stand-in for a module the shim does not provide. Every
   * property is another callable no-op, and calling or `new`-ing a no-op
   * yields another one, so arbitrary chains such as
   * `require('x').a().b.c()` or `new (require('x').Thing)().z` are harmless
   * instead of a TypeError that would kill engine startup.
   */
  function createNoop() {
    var noop = function () {};
    if (typeof Proxy === 'undefined') {
      // Without Proxy arbitrary property access cannot be intercepted. Return
      // a callable object so at least `mod()` and `mod.someKnownName` do not
      // throw. (Every real target has Proxy: Chromium WebView and Node.)
      return noop;
    }
    function child(target) {
      if (!target.__noop) target.__noop = createNoop();
      return target.__noop;
    }
    return new Proxy(noop, {
      get: function (target, prop) {
        if (prop === 'then') return undefined;
        if (typeof prop === 'symbol') return undefined;
        return child(target);
      },
      // Deliberately permissive and unresolved: we have no evidence which way
      // the engine's feature-detection wants `in` to answer, and answering
      // `false` could silently disable code paths. Leave it permissive.
      has: function () {
        return true;
      },
      set: function () {
        return true;
      },
      apply: function (target) {
        return child(target);
      },
      construct: function (target) {
        return child(target);
      }
    });
  }

  var modules = {
    path: pathModule,
    os: osModule,
    process: processObject
  };

  function requireModule(name) {
    var key = String(name == null ? '' : name);
    if (Object.prototype.hasOwnProperty.call(modules, key)) return modules[key];
    return createNoop();
  }

  /* ------------------------------------------------------------------ *
   * Publish the NW.js-ish environment
   * ------------------------------------------------------------------ */

  if (win) {
    win.require = requireModule;
    win.process = processObject;
    // Stable introspection hook for the headless harness (and on-device
    // debugging). Double-underscore namespaced so it cannot collide with an
    // engine global; Ruling 1's no-escape-check behaviour of resolvePath is
    // pinned by a test through this hook.
    win.__gcBridge = { resolvePath: resolvePath, toBuffer: toBuffer };
  }
})();
