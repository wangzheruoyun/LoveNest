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

  /**
   * Strip trailing slashes from a host-reported root (leaving `/` alone).
   *
   * The `__GCNative` contract only promises `gameRoot() -> String`; nothing
   * guarantees it is normalised. A trailing slash would break the lexical
   * containment check in `isInsideRoot` (`root + '/'` becomes `//`), making
   * every in-root path look like an escape — every save would fail with a
   * misleading `EACCES`. Normalising here, at the single read point, keeps
   * `process.cwd()`/`resolvePath()` clean too.
   */
  function normalizeRoot(p) {
    var s = String(p == null ? '' : p);
    var end = s.length;
    while (end > 1 && s.charAt(end - 1) === '/') end--;
    return s.slice(0, end);
  }

  function gameRoot() {
    if (host && typeof host.gameRoot === 'function') {
      return normalizeRoot(host.gameRoot());
    }
    return '/';
  }

  function docsRoot() {
    if (host && typeof host.docsRoot === 'function') {
      return normalizeRoot(host.docsRoot());
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
   * Encoding helpers (used by the `fs` shim)
   *
   * No `TextEncoder` / `TextDecoder` / `Buffer`: those may be absent in the
   * WebView, and Node 0.64-era engine code passes `'utf8'` and expects the
   * same bytes. The conversions are done by hand so the bridge behaves
   * identically in Chromium and in the `node:vm` harness.
   * ------------------------------------------------------------------ */

  /** Base64-encode a `Uint8Array` (or plain byte array). */
  function toBase64(bytes) {
    var s = '';
    var i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var n3 = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += B64_ALPHABET.charAt((n3 >> 18) & 63) +
        B64_ALPHABET.charAt((n3 >> 12) & 63) +
        B64_ALPHABET.charAt((n3 >> 6) & 63) +
        B64_ALPHABET.charAt(n3 & 63);
    }
    var rem = bytes.length - i;
    if (rem === 1) {
      var n1 = bytes[i] << 16;
      s += B64_ALPHABET.charAt((n1 >> 18) & 63) +
        B64_ALPHABET.charAt((n1 >> 12) & 63) + '==';
    } else if (rem === 2) {
      var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      s += B64_ALPHABET.charAt((n2 >> 18) & 63) +
        B64_ALPHABET.charAt((n2 >> 12) & 63) +
        B64_ALPHABET.charAt((n2 >> 6) & 63) + '=';
    }
    return s;
  }

  /** UTF-8 encode a string to a `Uint8Array` (lone surrogates become U+FFFD). */
  function utf8Encode(str) {
    var s = String(str == null ? '' : str);
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) {
          i++;
          var cp = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
          bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
            0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        } else {
          bytes.push(0xEF, 0xBF, 0xBD);
        }
      } else if (c >= 0xD800 && c <= 0xDFFF) {
        bytes.push(0xEF, 0xBF, 0xBD);
      } else {
        bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    var out = new Uint8Array(bytes.length);
    for (var j = 0; j < bytes.length; j++) out[j] = bytes[j];
    return out;
  }

  /** UTF-8 decode a `Uint8Array`; malformed sequences become U+FFFD. */
  function utf8Decode(bytes) {
    var out = '';
    var CHUNK = 8192;
    var chunk = [];
    function flush() {
      if (chunk.length > 0) {
        out += String.fromCharCode.apply(null, chunk);
        chunk.length = 0;
      }
    }
    var i = 0;
    var n = bytes.length;
    while (i < n) {
      var c = bytes[i++];
      if (c < 0x80) {
        chunk.push(c);
      } else if (c < 0xC0) {
        chunk.push(0xFFFD); // stray continuation byte
      } else if (c < 0xE0) {
        var c2 = bytes[i];
        if (c2 === undefined || (c2 & 0xC0) !== 0x80) {
          chunk.push(0xFFFD);
        } else {
          i++;
          chunk.push(((c & 0x1F) << 6) | (c2 & 0x3F));
        }
      } else if (c < 0xF0) {
        var c3 = bytes[i];
        var c4 = bytes[i + 1];
        if (c3 === undefined || (c3 & 0xC0) !== 0x80 ||
          c4 === undefined || (c4 & 0xC0) !== 0x80) {
          chunk.push(0xFFFD);
        } else {
          i += 2;
          chunk.push(((c & 0x0F) << 12) | ((c3 & 0x3F) << 6) | (c4 & 0x3F));
        }
      } else {
        var b2 = bytes[i];
        var b3 = bytes[i + 1];
        var b4 = bytes[i + 2];
        if (b2 === undefined || (b2 & 0xC0) !== 0x80 ||
          b3 === undefined || (b3 & 0xC0) !== 0x80 ||
          b4 === undefined || (b4 & 0xC0) !== 0x80) {
          chunk.push(0xFFFD);
        } else {
          i += 3;
          var point = ((c & 0x07) << 18) | ((b2 & 0x3F) << 12) |
            ((b3 & 0x3F) << 6) | (b4 & 0x3F);
          point -= 0x10000;
          chunk.push(0xD800 + (point >> 10), 0xDC00 + (point & 0x3FF));
        }
      }
      if (chunk.length >= CHUNK) flush();
    }
    flush();
    return out;
  }

  function latin1Encode(str) {
    var s = String(str == null ? '' : str);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  function latin1Decode(bytes) {
    var CHUNK = 8192;
    var out = '';
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + CHUNK));
    }
    return out;
  }

  function asciiEncode(str) {
    var s = String(str == null ? '' : str);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
    return out;
  }

  function asciiDecode(bytes) {
    var CHUNK = 8192;
    var out = '';
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + CHUNK));
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * `fs` shim — synchronous IO backed by the native host
   *
   * Error semantics (plan Ruling 6, Review Focus #1/#2). The native host
   * never throws: it reports failure as `null` / `false` / `'[]'`. The
   * engine, however, is Node-authored code written against Node semantics,
   * so this layer *translates* those sentinels into Node-faithful errors
   * with a `code` property (`ENOENT`, `EACCES`, `ENOTDIR`, `EISDIR`,
   * `EEXIST`). Silently handing back `null` where Node returns a `Buffer`
   * would surface downstream as a confusing `TypeError` inside the engine
   * instead of the `ENOENT`/`EACCES` the engine already knows how to catch
   * and report. `existsSync` is the one exception: Node's contract is
   * "never throws", so it returns `false` for every failure.
   *
   * The host remains the single authority for path resolution and escape
   * rejection (plan Ruling 1): every access still goes through the host,
   * which returns its failure sentinel for an escaping path. The roots are
   * consulted *only* to pick the error code, using the same lexical rule the
   * host itself applies to an already-normalised path — this layer never
   * allows an access the host refuses.
   * ------------------------------------------------------------------ */

  // Linux errno values, matching what Node reports on Android.
  var FS_ERRNO = {
    ENOENT: -2,
    EACCES: -13,
    EEXIST: -17,
    ENOTDIR: -20,
    EISDIR: -21
  };

  var FS_STRERROR = {
    ENOENT: 'no such file or directory',
    EACCES: 'permission denied',
    EEXIST: 'file already exists',
    ENOTDIR: 'not a directory',
    EISDIR: 'illegal operation on a directory'
  };

  /** Build a Node-shaped `Error` carrying `code` / `errno` / `syscall` / `path`. */
  function fsError(code, syscall, p) {
    var msg = (FS_STRERROR[code] || 'unknown error');
    var err = new Error(code + ': ' + msg + ', ' + syscall + " '" + p + "'");
    err.errno = FS_ERRNO[code];
    err.code = code;
    err.syscall = syscall;
    err.path = p;
    return err;
  }

  /**
   * Call a host method, absorbing any host-side throw into `undefined`.
   *
   * The arity matters on Android: `@JavascriptInterface` binds methods by name
   * *and* parameter count, so calling a zero-argument host method with an
   * extra `undefined` would miss the binding and throw. The no-argument branch
   * below is therefore not cosmetic.
   */
  function hostCall(name, arg1, arg2) {
    if (!host || typeof host[name] !== 'function') return undefined;
    try {
      if (arguments.length <= 1) return host[name]();
      if (arg2 === undefined) return host[name](arg1);
      return host[name](arg1, arg2);
    } catch (e) {
      return undefined;
    }
  }

  function isInsideRoot(abs, root) {
    if (!root || root === '/') return true;
    return abs === root || abs.indexOf(root + '/') === 0;
  }

  /** True when the resolved path is one the host is willing to touch. */
  function isWithinRoots(abs) {
    return isInsideRoot(abs, gameRoot()) || isInsideRoot(abs, docsRoot());
  }

  /** Parse `host.stat()` JSON text into `{isDirectory, size}` or `null`. */
  function parseStat(text) {
    if (typeof text !== 'string') return null;
    try {
      var info = JSON.parse(text);
      return (info && typeof info === 'object') ? info : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Node error for a failed read of `abs`: `EACCES` when the path escapes
   * both roots, `ENOENT` when it is simply absent, `fallback` otherwise.
   */
  function lookupFailure(abs, syscall, fallback) {
    if (!isWithinRoots(abs)) return fsError('EACCES', syscall, abs);
    if (hostCall('exists', abs) !== true) return fsError('ENOENT', syscall, abs);
    return fsError(fallback, syscall, abs);
  }

  /** Normalise the `options` argument of `readFile`/`writeFile` to a string. */
  function parseEncoding(options) {
    if (options === null || options === undefined) return null;
    if (typeof options === 'string') return options;
    if (typeof options === 'object' && typeof options.encoding === 'string') {
      return options.encoding;
    }
    return null; // `{encoding: null}` / `{}` means "give me the bytes"
  }

  /** Map an encoding string onto one of the four this shim implements. */
  function canonicalEncoding(enc) {
    if (enc === null || enc === undefined) return null;
    var e = String(enc).toLowerCase();
    if (e === 'utf8' || e === 'utf-8') return 'utf8';
    if (e === 'latin1' || e === 'binary') return 'latin1';
    if (e === 'ascii') return 'ascii';
    if (e === 'base64') return 'base64';
    // Unknown encodings fall back to UTF-8 rather than throwing
    // ERR_UNKNOWN_ENCODING: a readable string degrades far better inside the
    // engine than an exception on a path the engine did not expect to fail.
    return 'utf8';
  }

  function decodeWith(enc, bytes) {
    if (enc === 'latin1') return latin1Decode(bytes);
    if (enc === 'ascii') return asciiDecode(bytes);
    if (enc === 'base64') return toBase64(bytes);
    return utf8Decode(bytes);
  }

  /** Coerce `writeFileSync` data (string / Uint8Array / ArrayBuffer / array). */
  function toWriteBytes(data, options) {
    if (typeof data === 'string') {
      var enc = canonicalEncoding(parseEncoding(options)) || 'utf8';
      if (enc === 'base64') return toBuffer(data);
      if (enc === 'latin1') return latin1Encode(data);
      if (enc === 'ascii') return asciiEncode(data);
      return utf8Encode(data);
    }
    if (data === null || data === undefined) return new Uint8Array(0);
    if (typeof Uint8Array !== 'undefined' && data instanceof Uint8Array) return data;
    if (typeof ArrayBuffer !== 'undefined') {
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (ArrayBuffer.isView && ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      }
    }
    if (typeof data.length === 'number') {
      var out = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) out[i] = data[i] & 0xff;
      return out;
    }
    throw new TypeError('fs.writeFileSync: data must be a string or a Uint8Array');
  }

  /** The shape Node's `statSync` returns, reconstructed from host JSON. */
  function makeStats(info) {
    var isDir = !!(info && info.isDirectory);
    var size = (info && typeof info.size === 'number') ? info.size : 0;
    var nowMs = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
    return {
      size: size,
      mtimeMs: nowMs,
      atimeMs: nowMs,
      ctimeMs: nowMs,
      birthtimeMs: nowMs,
      mtime: new Date(nowMs),
      atime: new Date(nowMs),
      ctime: new Date(nowMs),
      birthtime: new Date(nowMs),
      isDirectory: function () { return isDir; },
      isFile: function () { return !isDir; },
      isSymbolicLink: function () { return false; },
      isBlockDevice: function () { return false; },
      isCharacterDevice: function () { return false; },
      isFIFO: function () { return false; },
      isSocket: function () { return false; }
    };
  }

  /** Schedule `fn` on the macrotask queue, the way Node's async fs does. */
  function defer(fn) {
    if (typeof setTimeout === 'function') setTimeout(fn, 0);
    else fn();
  }

  var fsModule = {
    existsSync: function (p) {
      try {
        return hostCall('exists', resolvePath(p)) === true;
      } catch (e) {
        return false;
      }
    },

    readFileSync: function (p, options) {
      var abs = resolvePath(p);
      var b64 = hostCall('readBase64', abs);
      if (typeof b64 !== 'string') throw lookupFailure(abs, 'open', 'EISDIR');
      var bytes = toBuffer(b64);
      var enc = canonicalEncoding(parseEncoding(options));
      return (enc === null) ? bytes : decodeWith(enc, bytes);
    },

    writeFileSync: function (p, data, options) {
      var abs = resolvePath(p);
      if (!isWithinRoots(abs)) throw fsError('EACCES', 'open', abs);
      var bytes = toWriteBytes(data, options);
      if (hostCall('writeBase64', abs, toBase64(bytes)) !== true) {
        var info = parseStat(hostCall('stat', abs));
        if (info && info.isDirectory) throw fsError('EISDIR', 'open', abs);
        throw fsError('EACCES', 'open', abs);
      }
      return undefined;
    },

    readdirSync: function (p) {
      var abs = resolvePath(p);
      var info = parseStat(hostCall('stat', abs));
      if (!info) throw lookupFailure(abs, 'scandir', 'ENOENT');
      if (!info.isDirectory) throw fsError('ENOTDIR', 'scandir', abs);
      var text = hostCall('readDir', abs);
      var names = null;
      if (typeof text === 'string') {
        try {
          names = JSON.parse(text);
        } catch (e) {
          names = null;
        }
      }
      if (!names || typeof names.length !== 'number') {
        throw fsError('EACCES', 'scandir', abs);
      }
      return names;
    },

    statSync: function (p) {
      var abs = resolvePath(p);
      var info = parseStat(hostCall('stat', abs));
      if (!info) {
        if (!isWithinRoots(abs)) throw fsError('EACCES', 'stat', abs);
        throw fsError('ENOENT', 'stat', abs);
      }
      return makeStats(info);
    },

    mkdirSync: function (p, options) {
      var abs = resolvePath(p);
      var recursive = !!(options && typeof options === 'object' && options.recursive);
      if (!isWithinRoots(abs)) throw fsError('EACCES', 'mkdir', abs);
      if (recursive) {
        if (hostCall('mkdirp', abs) !== true) throw fsError('EACCES', 'mkdir', abs);
        return undefined;
      }
      // Non-recursive `mkdir` must fail like Node when the target already
      // exists or the parent is missing; the host only offers a recursive
      // primitive, so those two cases are checked here first.
      if (hostCall('exists', abs) === true) throw fsError('EEXIST', 'mkdir', abs);
      var parent = dirname(abs);
      var parentInfo = parseStat(hostCall('stat', parent));
      if (!parentInfo) throw fsError('ENOENT', 'mkdir', abs);
      if (!parentInfo.isDirectory) throw fsError('ENOTDIR', 'mkdir', abs);
      if (hostCall('mkdirp', abs) !== true) throw fsError('EACCES', 'mkdir', abs);
      return undefined;
    },

    unlinkSync: function (p) {
      var abs = resolvePath(p);
      if (hostCall('unlink', abs) === true) return undefined;
      if (!isWithinRoots(abs)) throw fsError('EACCES', 'unlink', abs);
      var info = parseStat(hostCall('stat', abs));
      if (!info) throw fsError('ENOENT', 'unlink', abs);
      if (info.isDirectory) throw fsError('EISDIR', 'unlink', abs);
      throw fsError('EACCES', 'unlink', abs);
    },

    /* ---- asynchronous forms: the sync implementation, deferred ---- */

    readFile: function (p, options, cb) {
      if (typeof options === 'function') { cb = options; options = undefined; }
      if (typeof cb !== 'function') return undefined;
      defer(function () {
        var value;
        try {
          value = fsModule.readFileSync(p, options);
        } catch (err) {
          cb(err);
          return;
        }
        cb(null, value);
      });
      return undefined;
    },

    writeFile: function (p, data, options, cb) {
      if (typeof options === 'function') { cb = options; options = undefined; }
      if (typeof cb !== 'function') return undefined;
      defer(function () {
        try {
          fsModule.writeFileSync(p, data, options);
        } catch (err) {
          cb(err);
          return;
        }
        cb(null);
      });
      return undefined;
    },

    readdir: function (p, options, cb) {
      if (typeof options === 'function') { cb = options; options = undefined; }
      if (typeof cb !== 'function') return undefined;
      defer(function () {
        var value;
        try {
          value = fsModule.readdirSync(p, options);
        } catch (err) {
          cb(err);
          return;
        }
        cb(null, value);
      });
      return undefined;
    },

    stat: function (p, options, cb) {
      if (typeof options === 'function') { cb = options; options = undefined; }
      if (typeof cb !== 'function') return undefined;
      defer(function () {
        var value;
        try {
          value = fsModule.statSync(p);
        } catch (err) {
          cb(err);
          return;
        }
        cb(null, value);
      });
      return undefined;
    },

    mkdir: function (p, options, cb) {
      if (typeof options === 'function') { cb = options; options = undefined; }
      if (typeof cb !== 'function') return undefined;
      defer(function () {
        try {
          fsModule.mkdirSync(p, options);
        } catch (err) {
          cb(err);
          return;
        }
        cb(null);
      });
      return undefined;
    }
  };

  /* ------------------------------------------------------------------ *
   * Windows command layer — `child_process` and `nw.gui`
   *
   * The engine is a Windows-only NW.js build whose "fourth wall" Meta
   * performances read the player's real account name, read the Windows
   * version, change the desktop wallpaper, pop a tray balloon and shut the
   * computer down. Every one of them reaches the OS through
   * `require('child_process')` or `require('nw.gui')`; the call sites were
   * enumerated from the decoded engine source rather than guessed (see the
   * Task 4 report for the full list).
   *
   * This layer maps each command onto a *real* Android equivalent on the
   * native host instead of pretending to run it, so the performances survive
   * the port instead of silently becoming no-ops.
   * ------------------------------------------------------------------ */

  /**
   * Force a command result to pure ASCII, replacing anything above U+007F.
   *
   * The engine decodes `execSync(cmd, {encoding: 'buffer'})` output with
   * `new TextDecoder('gbk')`. A byte above 0x7F that is not valid GBK corrupts
   * the decode, so every string handed back on that path must stay ASCII.
   * `androidVersion()` is already ASCII; `deviceName()` (the phone's name,
   * often Chinese) is not.
   */
  function asciiOnly(value) {
    var s = String(value == null ? '' : value);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      out += (code < 0x80) ? s.charAt(i) : '?';
    }
    return out;
  }

  /** Read a host string accessor, mapping a missing/failed host to `''`. */
  function hostString(name) {
    var value = hostCall(name);
    return (value === undefined || value === null) ? '' : String(value);
  }

  /** `"…"` groups of a Windows command line, in order. */
  function quotedArgs(text) {
    var out = [];
    var re = /"([^"]*)"/g;
    var m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  }

  /** True for the flags of a nircmd/MessageShow box that are not user text. */
  function isPopupFlag(part) {
    return part === '' || part === 'infobox' || part === 'qboxcom' ||
      part.indexOf('MB_') === 0 || /^[0-9]+$/.test(part);
  }

  /** Human-readable notification text from a Windows popup command. */
  function popupMessage(parts) {
    var kept = [];
    for (var i = 0; i < parts.length; i++) {
      var part = String(parts[i]);
      if (!isPopupFlag(part)) kept.push(part);
    }
    return kept.join(' ');
  }

  /**
   * `reg add "…Control Panel\Desktop" /v Wallpaper /t REG_SZ /d "<path>" /f`
   * is how the engine's `FileUtilsOS.setWallpaperFromPath()` repaints the
   * Windows desktop. The Android equivalent is the host's `WallpaperManager`,
   * which takes the image as base64.
   */
  function setWallpaperFromCommand(text) {
    var m = /\/d\s+"([^"]*)"/.exec(text);
    if (!m) return;
    var b64 = hostCall('readBase64', resolvePath(m[1]));
    if (typeof b64 === 'string' && b64.length > 0) hostCall('setWallpaper', b64);
  }

  /**
   * Run one Windows command line, perform its Android side effect, and return
   * the ASCII stdout the engine expects (`''` for side-effect-only commands).
   *
   * Only the commands the engine is *observed* to run are listed; everything
   * else falls through to `host.log()` so an unexpected command is visible
   * instead of silent.
   */
  function runCommand(command) {
    var text = String(command == null ? '' : command);
    var lower = text.toLowerCase();

    // "read the player's real account name" — the first Meta performance.
    // `W26_WindowsFullName.fullName` takes line 2 of the output, so the shape
    // has to stay wmic-like. ASCII only: the engine GBK-decodes this buffer.
    if (lower.indexOf('wmic useraccount') !== -1) {
      return 'FullName\n\n' + asciiOnly(hostString('deviceName'));
    }

    // "read the Windows version" — also GBK-decoded, so ASCII only.
    if (lower.indexOf('wmic os get caption') !== -1) {
      return 'Android ' + asciiOnly(hostString('androidVersion'));
    }

    // `net user %username%` is the second "real name" performance
    // (`W26_VisualSysOpt.getWindowsFullName`). It reads line 2, drops the first
    // token, re-joins the rest with single spaces and then cuts the last two
    // characters — so the line needs a one-word label, and exactly one trailing
    // space, for the name to come back out whole.
    if (/(^|\s)net user(\s|$)/.test(lower)) {
      return '\n\nUser ' + asciiOnly(hostString('deviceName')) + ' ';
    }

    // "change the desktop wallpaper".
    if (lower.indexOf('reg add') !== -1 && lower.indexOf('wallpaper') !== -1) {
      setWallpaperFromCommand(text);
      return '';
    }

    // "shut down the computer": the full game runs `nircmd.exe shutdown`, this
    // Demo build's power-off command is `nircmd.exe hibernate` (customCommand_15033).
    // Either way Android plays the black-screen performance and quits the app —
    // it never really powers the device off.
    if (lower.indexOf('nircmd') !== -1 && /shutdown|hibernate|exitwin|poweroff/.test(lower)) {
      hostCall('fakeShutdown');
      return '';
    }

    // "pop a tray balloon", and the nircmd message boxes: a toast/notification.
    if (lower.indexOf('trayballoon') !== -1 ||
      (lower.indexOf('nircmd') !== -1 &&
        (lower.indexOf('"infobox"') !== -1 || lower.indexOf('"qboxcom"') !== -1))) {
      hostCall('toast', popupMessage(quotedArgs(text)));
      return '';
    }

    // Everything else is Windows-only plumbing: the wmic system-info queries
    // behind the trace console, nvidia-smi, rundll32, and scrnsave (the
    // "switch the monitor off" performance, which has no host capability yet).
    hostCall('log', text);
    return '';
  }

  /** True when the engine asked for raw bytes (`{encoding: 'buffer'}`). */
  function wantsBuffer(options) {
    var enc = parseEncoding(options);
    return typeof enc === 'string' && enc.toLowerCase() === 'buffer';
  }

  /**
   * The object `spawn()` returns. The engine only calls `ps.on('close', …)`,
   * which must fire or the waiting command never resumes.
   */
  function makeChildProcess() {
    var child = {
      on: function (event, listener) {
        var name = String(event);
        if ((name === 'close' || name === 'exit') && typeof listener === 'function') {
          defer(function () { listener(0); });
        }
        return child;
      }
    };
    return child;
  }

  var childProcessModule = {
    // `execSync(cmd)` → String; `execSync(cmd, {encoding:'buffer'})` → bytes.
    execSync: function (command, options) {
      var out = runCommand(command);
      return wantsBuffer(options) ? asciiEncode(out) : out;
    },

    // Node's `(error, stdout, stderr)` callback, always delivered
    // asynchronously — the engine drives a SyncTask off it. The side effect
    // itself happens now, so an `exec()` without a callback still lands.
    exec: function (command, options, callback) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      var out = runCommand(command);
      var stdout = wantsBuffer(options) ? asciiEncode(out) : out;
      if (typeof callback === 'function') {
        defer(function () { callback(null, stdout, ''); });
      }
      return undefined;
    },

    spawn: function (command, args) {
      var text = String(command == null ? '' : command);
      if (/messageshow/i.test(text)) {
        // `W26_MessageShow` runs MessageShow.exe for a Windows message box; the
        // Android equivalent is a notification.
        hostCall('toast', popupMessage(Array.isArray(args) ? args : []));
      } else {
        hostCall('log', text);
      }
      return makeChildProcess();
    }
  };

  /* --- `nw.gui` ------------------------------------------------------ */

  /**
   * The pseudo-window `nw.Window.get()` returns. The engine calls it
   * unconditionally at boot (`os._win = gcTop.require('nw.gui').Window.get()`)
   * and drives it from `SSZYG_WinSetting` / `SSZYG_WinResizeMove` /
   * `W26_VisualSysOpt`, so every member it touches must exist and must not
   * throw. Android has no movable desktop window, so the controls are inert;
   * only `close()` has a real meaning — the engine's "quit the game", which
   * the host implements as the shutdown performance followed by `finish()`.
   */
  function makeWindow() {
    var noop = function () {};
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      close: function () { hostCall('fakeShutdown'); },
      show: noop,
      hide: noop,
      moveTo: noop,
      resizeTo: noop,
      minimize: noop,
      maximize: noop,
      restore: noop,
      setResizable: noop,
      setAlwaysOnTop: noop,
      setMaximumSize: noop,
      setMinimumSize: noop,
      enterFullscreen: noop,
      leaveFullscreen: noop,
      getPrinters: function (cb) {
        if (typeof cb === 'function') defer(function () { cb([]); });
      },
      print: function (options, cb) {
        if (typeof cb === 'function') defer(function () { cb(); });
      },
      on: function () { return this; }
    };
  }

  /** `nw.Clipboard.get()`: the engine reads and writes `'text'`. */
  function makeClipboard() {
    return {
      get: function (type) {
        if (type === undefined || type === 'text') return hostString('clipboardGet');
        return '';
      },
      set: function (data, type) {
        if (type === undefined || type === 'text') {
          hostCall('clipboardSet', String(data == null ? '' : data));
        }
        return undefined;
      }
    };
  }

  var nwGuiModule = {
    Window: { get: makeWindow },
    Clipboard: { get: makeClipboard },
    Shell: {
      // `nw.Shell.openItem(path)` → the Android "open this file" Intent.
      openItem: function (p) {
        return hostCall('openFile', String(p == null ? '' : p)) === true;
      }
    }
  };

  /* ------------------------------------------------------------------ *
   * `require` with a lazy no-op fallback
   * ------------------------------------------------------------------ */

  // `Symbol` is an ES6 built-in; guard it so the ES5 syntax rule is respected.
  var symbolToPrimitive = (typeof Symbol !== 'undefined' && Symbol.toPrimitive) ? Symbol.toPrimitive : null;

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
        // Primitive coercion hooks must yield a *primitive*, otherwise
        // `String(mod)` / `'' + mod` / `mod == x` throw "Cannot convert object
        // to primitive value" — a TypeError on a path that used to degrade.
        if (symbolToPrimitive !== null && prop === symbolToPrimitive) {
          return function () {
            return '';
          };
        }
        if (prop === 'toString' || prop === 'valueOf') {
          return function () {
            return '';
          };
        }
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
    process: processObject,
    fs: fsModule,
    child_process: childProcessModule,
    'nw.gui': nwGuiModule
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
    // debugging). Non-enumerable so an engine-wide `for...in window` /
    // `Object.keys(window)` scan never sees it, and non-writable so the engine
    // cannot clobber it. Guarded so a re-injection of the bridge into the same
    // window does not redefine it. Ruling 1's no-escape-check behaviour of
    // resolvePath is pinned by a test through this hook.
    if (!Object.prototype.hasOwnProperty.call(win, '__gcBridge')) {
      Object.defineProperty(win, '__gcBridge', {
        value: { resolvePath: resolvePath, toBuffer: toBuffer },
        enumerable: false,
        writable: false,
        configurable: false
      });
    }
  }
})();
