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
   * Real desktop wallpaper (`W26_DesktopWallpaper`) — a virtual APPDATA tree
   *
   * The engine's "read the player's real wallpaper" performance does not use
   * `child_process`/`nw.gui`: it walks
   * `path.join(process.env.APPDATA, "\\Microsoft\\Windows\\Themes\\")` with
   * `fs.existsSync` / `readdirSync` / `accessSync` / `readFileSync`. Android has
   * no such path, so `process.env.APPDATA` points at this synthetic root and
   * those four probes are answered from the host's real wallpaper
   * (`host.getWallpaper()`). When a wallpaper is available the tree looks
   * exactly like a Windows profile whose `CachedFiles` directory is populated,
   * so the engine takes the same branch it takes there; when the host reports
   * none, the whole tree reports "absent" and the engine degrades to an empty
   * string, just as it would on a fresh Windows install.
   * ------------------------------------------------------------------ */

  var WALLPAPER_ROOT = '/__wallpaper__';

  // One synthetic filename, so `getDesktopWallpaperFiles()` finds a non-empty
  // `CachedFiles` directory and reads its first (only) entry.
  var WALLPAPER_ENTRY = 'TranscodedWallpaper';

  // Memoised `getWallpaper()` result: the successful base64 and the host
  // function it came from.
  var wallpaperCacheFn = null;
  var wallpaperCacheValue = null;

  /**
   * The host's wallpaper bytes as base64, or `null` when it cannot read one.
   *
   * The engine probes the virtual tree up to five times per performance
   * (`existsSync` / `readdirSync` / `accessSync` / `readFileSync` / `statSync`),
   * and on Android each probe redraws and PNG-compresses the wallpaper, so a
   * *successful* read is memoised. The cache is keyed on the host function
   * itself and a *failed* read is never cached, so a later probe — or a new
   * host — is retried rather than pinned to a stale `null`.
   */
  function wallpaperBase64() {
    var getter = (host && typeof host.getWallpaper === 'function') ? host.getWallpaper : null;
    if (getter === null) return null;
    if (getter === wallpaperCacheFn) return wallpaperCacheValue;
    var b64 = hostCall('getWallpaper');
    var value = (typeof b64 === 'string' && b64.length > 0) ? b64 : null;
    if (value !== null) {
      wallpaperCacheFn = getter;
      wallpaperCacheValue = value;
    } else {
      invalidateWallpaperCache();
    }
    return value;
  }

  /**
   * Drop the memoised wallpaper. Called when a read fails (so the next probe
   * retries) and whenever the engine *changes* the wallpaper — otherwise a
   * performance that sets the wallpaper and then reads it back would show the
   * image from before the change.
   */
  function invalidateWallpaperCache() {
    wallpaperCacheFn = null;
    wallpaperCacheValue = null;
  }

  /** True when `abs` (already host-absolute) is inside the virtual tree. */
  function isWallpaperPath(abs) {
    return abs === WALLPAPER_ROOT || abs.indexOf(WALLPAPER_ROOT + '/') === 0;
  }

  /** True for the virtual directories (`Themes/`, `CachedFiles/`), not the file. */
  function isWallpaperDir(abs) {
    return abs.indexOf(WALLPAPER_ENTRY) === -1;
  }

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
    // `APPDATA` is the one environment variable the engine reads (for the
    // wallpaper path above); leaving it empty would make `path.join` drop it
    // and land the walk inside the game root. Keep it a non-empty absolute
    // value so the engine stays on its Windows code path.
    env: { APPDATA: WALLPAPER_ROOT },
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
   * Node's `Buffer#toString(encoding)`, implemented for the plain byte arrays
   * `fs.readFileSync(…, {encoding: null})` hands back.
   *
   * The engine turns the wallpaper bytes into a data URL with
   * `data.toString('base64')`. A bare `Uint8Array` has a `toString` that joins
   * the *decimal* byte values with commas (`"137,80,78,…"`), which would render
   * as a broken image. Attaching Node's own encoding argument here keeps that
   * last step working without a real `Buffer` polyfill.
   */
  function bufferToString(enc) {
    var e = (enc === undefined || enc === null) ? 'utf8' : String(enc).toLowerCase();
    if (e === 'base64') return toBase64(this);
    if (e === 'latin1' || e === 'binary') return latin1Decode(this);
    if (e === 'ascii') return asciiDecode(this);
    return utf8Decode(this);
  }

  /** Give a byte array Node's `toString(encoding)`, non-enumerably. */
  function attachBufferMethods(bytes) {
    try {
      Object.defineProperty(bytes, 'toString', {
        value: bufferToString,
        enumerable: false,
        writable: true,
        configurable: true
      });
    } catch (e) {
      // A frozen / exotic array is still readable; only `toString` is lost.
    }
    return bytes;
  }

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
    var result;
    if (out === bytes.length) {
      result = bytes;
    } else {
      result = new Uint8Array(out);
      for (var j = 0; j < out; j++) result[j] = bytes[j];
    }
    return attachBufferMethods(result);
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
    EISDIR: -21,
    ENOTEMPTY: -39
  };

  var FS_STRERROR = {
    ENOENT: 'no such file or directory',
    EACCES: 'permission denied',
    EEXIST: 'file already exists',
    ENOTDIR: 'not a directory',
    EISDIR: 'illegal operation on a directory',
    ENOTEMPTY: 'directory not empty'
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

  /* ------------------------------------------------------------------ *
   * Diagnostics — instrumentation only, gated on `window.__gcDiag`
   *
   * Nothing in this block runs unless the host Activity sets
   * `window.__gcDiag = true` before the page loads. That is the whole safety
   * property: the shipped shim (flag absent) behaves exactly as it did before
   * these lines existed, and a `__gcDiag` run differs only by log output.
   * ------------------------------------------------------------------ */

  /** A payload larger than this is worth a warning line, either direction. */
  var DIAG_BIG_BYTES = 4 * 1024 * 1024;

  /** True only when the Activity opted in before load. Never cached. */
  function diagEnabled() {
    try {
      return !!(win && win.__gcDiag === true);
    } catch (e) {
      return false;
    }
  }

  /**
   * Write one diagnostic line through the host's `log`. Calls the host member
   * directly — *not* through `hostCall` — so diagnosing a call can never
   * recurse into diagnosing the diagnosis. Never throws.
   */
  function diagWrite(line) {
    if (!host || typeof host.log !== 'function') return;
    try {
      host.log(String(line));
    } catch (e) {
      // A host that cannot log must not break the call it was observing.
    }
  }

  /**
   * Payload size of one host argument or return value, in characters. Only
   * strings carry a payload; `true`/`undefined` and friends count as zero.
   */
  function diagSize(value) {
    return (typeof value === 'string') ? value.length : 0;
  }

  /** Emit the >4 MB warning for one direction of one call. */
  function diagBig(name, dir, bytes) {
    if (bytes > DIAG_BIG_BYTES) {
      diagWrite('BIG ' + name + ' dir=' + dir + ' bytes=' + bytes);
    }
  }

  /** Wall clock, in ms. Guarded because exotic hosts may lack `Date`. */
  function diagNow() {
    try {
      return Date.now();
    } catch (e) {
      return 0;
    }
  }

  /**
   * `setTimeout` that works in both the WebView and the `node:vm` harness.
   *
   * In the browser `win.setTimeout` exists; in the harness it may only exist as
   * a bare global. Never throws: instrumentation must not fail a page.
   */
  function diagSetTimeout(fn, ms) {
    try {
      if (win && typeof win.setTimeout === 'function') return win.setTimeout(fn, ms);
    } catch (e) {}
    try {
      if (typeof setTimeout === 'function') return setTimeout(fn, ms);
    } catch (e) {}
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Task 12 — black-screen v2 probes
   *
   * Every probe below is installed only from `installDiagnostics()`, i.e. only
   * when `window.__gcDiag === true`. With the flag absent this whole block is
   * dead code: no global is replaced, no timer is armed, no line is written.
   *
   * The decisive measurement is the requestAnimationFrame differential:
   *
   *   rafSched — anything asked for a frame
   *   rafFired — a frame callback was actually delivered
   *
   *   rafSched climbing, rafFired frozen  ⇒ 甲 (frame production stopped)
   *   rafSched frozen,   hb climbing      ⇒ 乙 (the engine's loop stopped)
   *   both climbing                        ⇒ the engine is painting black
   * ------------------------------------------------------------------ */

  /** Bounded ring of the most recent resource-timing entries. */
  var DIAG_RESOURCE_RING = 200;

  /** Resource timing is logged only above these thresholds, to avoid a flood. */
  var DIAG_SLOW_MS = 500;
  var DIAG_BIG_RESOURCE = 1024 * 1024;

  var diagState = {
    rafSched: 0,
    rafFired: 0,
    ctxLost: 0,
    ctxRestored: 0,
    ctxCreateErr: 0,
    ctxLostPrevented: 0,
    audPlay: 0,
    // Task 13: WebAudio nodes are what the engine actually plays through (the
    // device run showed `audioEl=0` while an AudioContext was `running`), so
    // counting `<audio>` elements alone never measured "is it still making
    // sound". These two counters count rendered audio buffers directly.
    absStart: 0,
    absStop: 0,
    // Task 13: per-frame GL activity. Cheap increments (a few per frame) so
    // they cannot perturb the rAF/frame-rate measurement they sit next to.
    draws: 0,
    clear: 0,
    texUp: 0,
    readPx: 0,
    bufData: 0,
    audioContexts: [],
    glContexts: [],
    pending: {},
    pendingSeq: 0,
    pendingCount: 0,
    resources: [],
    factsLogged: false,
    // Task 13: the one-shot framebuffer sample request. A trigger (timer /
    // STALL / volume-down) only *arms* this; the read itself happens inside
    // the engine's next rAF callback frame (see diagRunCanvasSample).
    fbSamplePending: 0,
    fbSampleReason: ''
  };

  /** Mark a canvas as having yielded a WebGL context, for the facts line. */
  function diagCanvasSize(canvas) {
    var w = 0;
    var h = 0;
    try { w = Number(canvas.width) || 0; } catch (e) {}
    try { h = Number(canvas.height) || 0; } catch (e) {}
    return { w: w, h: h };
  }

  /**
   * Attach the three WebGL context events to one canvas, once per context.
   *
   * `webglcontextlost` deliberately does **not** call `preventDefault()`: this
   * build observes the browser's default (non-recovering) behaviour, which is
   * exactly the symptom under investigation. Instead it reads
   * `event.defaultPrevented` one macrotask later, after the engine's own
   * listeners have run, and records whether the engine intends to recover.
   */
  function diagAttachGlContext(canvas, ctx, type) {
    var i;
    for (i = 0; i < diagState.glContexts.length; i++) {
      if (diagState.glContexts[i].ctx === ctx) return;
    }
    // `lost` is the per-context state the framebuffer sample reports, as
    // opposed to `diagState.ctxLost`, which is a whole-session count.
    var entry = { ctx: ctx, canvas: canvas, type: String(type || ''), lost: false };
    diagState.glContexts.push(entry);
    try { canvas.__gcDiagGl = true; } catch (e) {}

    if (typeof canvas.addEventListener !== 'function') return;
    try {
      canvas.addEventListener('webglcontextlost', function (event) {
        diagState.ctxLost++;
        entry.lost = true;
        var size = diagCanvasSize(canvas);
        diagWrite('CTX lost canvas=' + size.w + 'x' + size.h + ' type=' + type);
        diagSetTimeout(function () {
          var prevented = false;
          try { prevented = !!(event && event.defaultPrevented); } catch (e) {}
          if (prevented) diagState.ctxLostPrevented++;
          diagWrite('CTX lost defaultPrevented=' + prevented);
        }, 0);
      }, false);
      canvas.addEventListener('webglcontextrestored', function () {
        diagState.ctxRestored++;
        entry.lost = false;
        var size = diagCanvasSize(canvas);
        diagWrite('CTX restored canvas=' + size.w + 'x' + size.h + ' type=' + type);
      }, false);
      canvas.addEventListener('webglcontextcreationerror', function (event) {
        diagState.ctxCreateErr++;
        var msg = '';
        try { msg = (event && event.statusMessage) ? String(event.statusMessage) : ''; } catch (e) {}
        diagWrite('CTX createerror message=' + msg);
      }, false);
    } catch (e) {
      // A canvas that refuses listeners simply goes unobserved.
    }
  }

  /** Hook `getContext` transparently: same arguments, same return value. */
  function diagInstallContextProbe() {
    var proto = null;
    try { proto = win && win.HTMLCanvasElement && win.HTMLCanvasElement.prototype; } catch (e) {}
    if (!proto || typeof proto.getContext !== 'function') return;
    var originalGetContext = proto.getContext;
    proto.getContext = function () {
      var ctx = originalGetContext.apply(this, arguments);
      try {
        var type = arguments.length > 0 ? String(arguments[0]) : '';
        if (ctx && (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2')) {
          diagAttachGlContext(this, ctx, type);
        }
      } catch (e) {}
      return ctx;
    };
  }

  /** rAF wrapper: preserve `this`, the timestamp and the returned handle. */
  function diagInstallRafProbe() {
    if (!win || typeof win.requestAnimationFrame !== 'function') return;
    var originalRaf = win.requestAnimationFrame;
    win.requestAnimationFrame = function (callback) {
      diagState.rafSched++;
      if (typeof callback !== 'function') {
        // Pass non-functions through untouched: whatever the platform did
        // before (usually a TypeError) still happens, with the same arguments.
        return originalRaf.call(win, callback);
      }
      var wrapped = function (timestamp) {
        diagState.rafFired++;
        // The engine draws *inside* this callback. The framebuffer sample must
        // therefore run here, in the same frame, right after the callback
        // returns — see diagRunCanvasSample() for why a timer cannot be used.
        try {
          return callback.call(this, timestamp);
        } finally {
          try { diagRunCanvasSample(); } catch (e) {}
        }
      };
      return originalRaf.call(win, wrapped);
    };
  }

  /* ---- Task 13: draw-call counters and the framebuffer sample ---------- */

  /**
   * Wrap the GL methods the black-screen question hinges on, each into one
   * cheap counter (a handful of increments per frame, so the counters cannot
   * perturb the frame-rate measurement they sit next to):
   *
   *   draws  = drawArrays + drawElements + drawArraysInstanced + drawElementsInstanced
   *   clear  = clear + clearColor
   *   texUp  = texImage2D + texSubImage2D
   *   readPx = readPixels
   *
   * `bufferData` is counted too but only surfaces in the dump, since it has no
   * heartbeat field. Both GL prototypes are wrapped; a method WebGL2 inherits
   * from WebGL1 is skipped the second time, so it cannot double-count.
   */
  function diagInstallDrawProbe() {
    var names = [
      ['drawArrays', 'draws'],
      ['drawElements', 'draws'],
      ['drawArraysInstanced', 'draws'],
      ['drawElementsInstanced', 'draws'],
      ['clear', 'clear'],
      ['clearColor', 'clear'],
      ['texImage2D', 'texUp'],
      ['texSubImage2D', 'texUp'],
      ['bufferData', 'bufData'],
      ['readPixels', 'readPx']
    ];
    var protos = [];
    try { if (win.WebGLRenderingContext) protos.push(win.WebGLRenderingContext.prototype); } catch (e) {}
    try { if (win.WebGL2RenderingContext) protos.push(win.WebGL2RenderingContext.prototype); } catch (e) {}
    for (var p = 0; p < protos.length; p++) {
      for (var i = 0; i < names.length; i++) {
        try {
          var proto = protos[p];
          if (!proto) continue;
          var original = proto[names[i][0]];
          if (typeof original !== 'function' || original.__gcDiagCounter) continue;
          (function (proto2, method, key, originalMethod) {
            var wrapped = function () {
              diagState[key]++;
              return originalMethod.apply(this, arguments);
            };
            wrapped.__gcDiagCounter = true;
            proto2[method] = wrapped;
          })(proto, names[i][0], names[i][1], original);
        } catch (e) {}
      }
    }
  }

  /** The largest WebGL context/canvas on the page, or null when there is none. */
  function diagPickGlContext() {
    var target = null;
    var bestArea = -1;
    for (var i = 0; i < diagState.glContexts.length; i++) {
      var item = diagState.glContexts[i];
      var size = diagCanvasSize(item.canvas);
      var area = size.w * size.h;
      if (area > bestArea) {
        bestArea = area;
        target = item;
      }
    }
    return target;
  }

  /**
   * Arm exactly one framebuffer sample. Triggers — the t+8/16/30 s timers, the
   * STALL detector (through the native `SAMPLE_FB_*` call) and volume-down —
   * only set this flag; the read itself runs from `diagRunCanvasSample()`,
   * which is invoked from the rAF wrapper. Several triggers before that frame
   * collapse into one sample (the newest reason wins). This is the entry point
   * the native side calls as `window.__gcDiagSampleCanvas(reason)`.
   */
  function diagRequestCanvasSample(reason) {
    diagState.fbSamplePending = 1;
    diagState.fbSampleReason = String(reason || '');
  }

  /**
   * Read a sparse 16x16 = 256-point grid out of the engine's framebuffer and
   * write one `FB sample …` line.
   *
   * This MUST run inside the engine's rAF callback, immediately after the
   * engine's own callback has returned — hence it is called from the rAF
   * wrapper and never from a timer. With the default
   * `preserveDrawingBuffer: false` the drawing buffer is only guaranteed to
   * hold the frame until the end of the frame in which it was drawn; once the
   * browser has composited, a `readPixels` issued from a `setTimeout` reads an
   * undefined buffer (usually the cleared one) and would report "black" no
   * matter what the engine actually painted. In-frame is the whole point.
   *
   * Fields: `pts` grid points read; `nonBlack` those whose maximum channel is
   * above 8 (a small tolerance for GL noise); `mean` the average channel over
   * every point, black pixels included; `max` the largest channel seen;
   * `ctxLost` the target context's own lost state; `glErr` `getError()`
   * immediately after the reads (the brief asks for the error when
   * `readPixels` fails or returns all-zero). `t`/`reason` are extensions that
   * let the controller tell a timer sample from a STALL or manual one.
   */
  function diagRunCanvasSample() {
    if (!diagState.fbSamplePending) return;
    diagState.fbSamplePending = 0;
    var reason = diagState.fbSampleReason;
    var target = diagPickGlContext();
    if (!target) {
      diagWrite('FB sample none t=' + diagNow() + ' reason=' + reason);
      return;
    }
    var size = diagCanvasSize(target.canvas);
    var buf = new Uint8Array(4);
    var pts = 0;
    var nonBlack = 0;
    var maxChannel = 0;
    var sumR = 0;
    var sumG = 0;
    var sumB = 0;
    var errorName = '';
    try {
      var gl = target.ctx;
      for (var gy = 0; gy < 16; gy++) {
        var y = Math.floor((gy + 0.5) * size.h / 16);
        for (var gx = 0; gx < 16; gx++) {
          var x = Math.floor((gx + 0.5) * size.w / 16);
          buf[0] = 0;
          buf[1] = 0;
          buf[2] = 0;
          buf[3] = 0;
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          var r = buf[0];
          var g = buf[1];
          var b = buf[2];
          pts++;
          sumR += r;
          sumG += g;
          sumB += b;
          if (r > maxChannel) maxChannel = r;
          if (g > maxChannel) maxChannel = g;
          if (b > maxChannel) maxChannel = b;
          if (r > 8 || g > 8 || b > 8) nonBlack++;
        }
      }
    } catch (e) {
      errorName = (e && e.name) ? String(e.name) : 'error';
    }
    var glErr = -1;
    try { glErr = Number(target.ctx.getError()); } catch (e) {}
    var line = 'FB sample canvas=' + size.w + 'x' + size.h +
      ' pts=' + pts + ' nonBlack=' + nonBlack +
      ' mean=' + (pts ? Math.round(sumR / pts) : 0) + ',' +
        (pts ? Math.round(sumG / pts) : 0) + ',' +
        (pts ? Math.round(sumB / pts) : 0) +
      ' max=' + maxChannel +
      ' ctxLost=' + (target.lost ? 'true' : 'false') +
      ' glErr=' + glErr +
      ' t=' + diagNow() + ' reason=' + reason;
    if (errorName) line += ' error=' + errorName;
    diagWrite(line);
  }

  /** One `RAF_NEVER_USED` record if nothing schedules a frame in 10 s. */
  function diagScheduleRafNeverUsed() {
    var timer = diagSetTimeout(function () {
      if (diagState.rafSched === 0) {
        diagWrite('RAF_NEVER_USED t=' + diagNow());
      }
    }, 10000);
    try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch (e) {}
  }

  /** `state` of an AudioContext, or `unknown` when it cannot be read. */
  function diagAudioState(ctx) {
    try { return (ctx && ctx.state) ? String(ctx.state) : 'unknown'; } catch (e) { return 'unknown'; }
  }

  /**
   * Keep every AudioContext the engine creates, and log when one appears.
   * `AudioContext` is hooked without `Reflect.construct` (ES5): `Function.bind`
   * builds a constructor that forwards the original arguments, and the wrapper
   * returns the real context object, so `new` semantics are preserved.
   */
  function diagHookAudioContext(name) {
    var Original = null;
    try { Original = win[name]; } catch (e) {}
    if (typeof Original !== 'function') return;
    var Wrapped = function () {
      var args = Array.prototype.slice.call(arguments);
      var Bound = Original.bind.apply(Original, [null].concat(args));
      var ctx = new Bound();
      var i;
      for (i = 0; i < diagState.audioContexts.length; i++) {
        if (diagState.audioContexts[i] === ctx) return ctx;
      }
      diagState.audioContexts.push(ctx);
      diagWrite('AUDIO context state=' + diagAudioState(ctx));
      return ctx;
    };
    Wrapped.prototype = Original.prototype;
    try { win[name] = Wrapped; } catch (e) {}
  }

  /**
   * Wrap one prototype method so a named counter increments on every call,
   * then pass the call through untouched (same `this`, same arguments, same
   * return value). Idempotent, and a no-op when the constructor/method is
   * absent. Used for the GL call counters and the WebAudio node counters.
   */
  function diagHookCounterMethod(ctor, method, key) {
    try {
      if (typeof ctor !== 'function' || !ctor.prototype) return;
      var proto = ctor.prototype;
      var original = proto[method];
      if (typeof original !== 'function') return;
      if (original.__gcDiagCounter) return;
      var wrapped = function () {
        diagState[key]++;
        return original.apply(this, arguments);
      };
      wrapped.__gcDiagCounter = true;
      proto[method] = wrapped;
    } catch (e) {}
  }

  /** Count `play()` calls; an audio start is otherwise invisible page-side. */
  function diagInstallAudioProbe() {
    try {
      var proto = win && win.HTMLMediaElement && win.HTMLMediaElement.prototype;
      if (proto && typeof proto.play === 'function') {
        var originalPlay = proto.play;
        proto.play = function () {
          diagState.audPlay++;
          var src = '';
          try { src = String(this.currentSrc || this.src || ''); } catch (e) {}
          diagWrite('AUDIO play calls=' + diagState.audPlay + ' src=' + src);
          return originalPlay.apply(this, arguments);
        };
      }
    } catch (e) {}
    // Task 13: the engine plays through WebAudio, so `AudioBufferSourceNode`
    // start/stop — not `<audio>` — is the real "is it still making sound".
    try {
      var ABS = win && win.AudioBufferSourceNode;
      diagHookCounterMethod(ABS, 'start', 'absStart');
      diagHookCounterMethod(ABS, 'stop', 'absStop');
    } catch (e) {}
    diagHookAudioContext('AudioContext');
    diagHookAudioContext('webkitAudioContext');
  }

  /** Audio liveness sampled at every heartbeat (and in a STALL dump). */
  function diagAudioFacts() {
    var out = { elements: 0, paused: 0, maxTime: 0, ended: 0, contexts: [], ctxTime: -1 };
    try {
      var nodes = (win.document && win.document.querySelectorAll) ?
        win.document.querySelectorAll('audio, video') : null;
      for (var i = 0; nodes && i < nodes.length; i++) {
        var el = nodes[i];
        out.elements++;
        try { if (el.paused) out.paused++; } catch (e) {}
        try { if (el.ended) out.ended++; } catch (e) {}
        try {
          var t = Number(el.currentTime);
          if (!isNaN(t) && t > out.maxTime) out.maxTime = t;
        } catch (e) {}
      }
    } catch (e) {}
    for (var j = 0; j < diagState.audioContexts.length; j++) {
      out.contexts.push(diagAudioState(diagState.audioContexts[j]));
      // Task 13: `currentTime` is the audio clock. If it stops advancing while
      // the picture is black, the engine's audio graph is dead too.
      try {
        var ct = Number(diagState.audioContexts[j].currentTime);
        if (!isNaN(ct) && ct > out.ctxTime) out.ctxTime = ct;
      } catch (e) {}
    }
    return out;
  }

  /** Byte count of any `diagBytesOf`-able response shape. */
  function diagBytesOf(value) {
    if (value === null || value === undefined) return -1;
    try {
      if (typeof value === 'string') return value.length;
      if (typeof value.byteLength === 'number') return value.byteLength;
      if (typeof value.size === 'number') return value.size;
      if (typeof value.length === 'number') return value.length;
    } catch (e) {}
    return -1;
  }

  /**
   * UTF-8 byte length of a JS string, without `TextEncoder` (it is not part of
   * the ES5 shim's vocabulary and may be absent in the harness). Correct for
   * BMP text and for surrogate pairs; a lone surrogate is counted as the 3-byte
   * U+FFFD that the WebView would emit.
   */
  function diagUtf8Bytes(str) {
    var bytes = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff) {
        var next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
        else bytes += 3;
      } else bytes += 3;
    }
    return bytes;
  }

  /**
   * Byte accounting for a finished XHR, carrying the *source* of the number and
   * the `responseText` length separately.
   *
   * `bytes` is a real byte count wherever one exists:
   *   - `arraybuffer` / `blob` → the response's `byteLength` / `size`;
   *   - text                   → the string's UTF-8 byte length.
   * `len` is `responseText.length`, i.e. UTF-16 code units, and `-1` for binary.
   *
   * This fixes the v2 measurement defect: reading `responseText.length` on a
   * Chinese JSON reported 971490 against 1025562 bytes on disk, because code
   * units are not bytes. `src`/`len` now make the two distinguishable in the log.
   */
  function diagXhrByteInfo(xhr) {
    var info = { bytes: -1, src: 'null', len: -1 };
    try {
      var type = String(xhr.responseType || '');
      if (type === 'arraybuffer' || type === 'blob') {
        info.src = type;
        info.bytes = diagBytesOf(xhr.response);
        return info;
      }
      var text = null;
      try { text = xhr.responseText; } catch (e) { text = null; }
      if (text === null || text === undefined) return info;
      info.src = 'text';
      info.len = text.length;
      info.bytes = diagUtf8Bytes(text);
      return info;
    } catch (e) {
      return info;
    }
  }

  function diagStartPending(kind, url, method) {
    var id = ++diagState.pendingSeq;
    diagState.pending[id] = {
      kind: kind,
      method: String(method || ''),
      url: String(url || ''),
      startedAt: diagNow()
    };
    diagState.pendingCount++;
    diagWrite('REQ start id=' + id + ' kind=' + kind +
      (method ? ' method=' + String(method) : '') + ' url=' + String(url || ''));
    return id;
  }

  function diagFinishPending(id, ok, status, bytes, err, info) {
    var req = diagState.pending[id];
    if (!req) return;
    diagState.pending[id] = null;
    try { delete diagState.pending[id]; } catch (e) {}
    if (diagState.pendingCount > 0) diagState.pendingCount--;
    var line = 'REQ done id=' + id + ' kind=' + req.kind + ' ok=' + ok +
      ' status=' + status + ' bytes=' + bytes;
    // Task 13: the *source* of the byte count and the code-unit length, when
    // the completion came from an XHR response (see diagXhrByteInfo).
    if (info) line += ' src=' + info.src + ' len=' + info.len;
    line += ' ms=' + (diagNow() - req.startedAt);
    if (err) line += ' err=' + err;
    line += ' url=' + req.url;
    diagWrite(line);
  }

  /** XHR tracing: `open` records, `send` starts a pending entry, `loadend` ends it. */
  function diagInstallXhrProbe() {
    var XHR = null;
    try { XHR = win && win.XMLHttpRequest; } catch (e) {}
    if (!XHR || !XHR.prototype) return;
    var proto = XHR.prototype;
    var originalOpen = proto.open;
    var originalSend = proto.send;
    if (typeof originalOpen !== 'function' || typeof originalSend !== 'function') return;

    proto.open = function (method, url) {
      try {
        // Task 13: settle a reused XHR's in-flight entry *before* the real
        // `open()` runs. `open()` synchronously terminates an in-flight fetch
        // and fires `abort`/`loadend` from inside that call; by then the id had
        // already been zeroed here, so the `loadend` handler below bailed out
        // on `if (!reqId) return;` and the entry leaked forever (`pend=7`).
        // Reuse is the loader's normal pooling, so the abort is bookkeeping,
        // not an error. The late `loadend` then sees id 0 and stays silent.
        var previousId = this.__gcDiagId;
        if (previousId) diagFinishPending(previousId, false, 0, -1, 'abort');
        this.__gcDiagMethod = String(method == null ? '' : method);
        this.__gcDiagUrl = String(url == null ? '' : url);
        this.__gcDiagId = 0;
        this.__gcDiagError = '';
      } catch (e) {}
      return originalOpen.apply(this, arguments);
    };

    proto.send = function () {
      var self = this;
      var id = 0;
      try {
        id = diagStartPending('xhr', this.__gcDiagUrl || '', this.__gcDiagMethod || '');
        this.__gcDiagId = id;
      } catch (e) {}

      try {
        if (typeof this.addEventListener === 'function' && !this.__gcDiagWired) {
          this.__gcDiagWired = true;
          this.addEventListener('error', function () {
            try { self.__gcDiagError = 'error'; } catch (e) {}
          }, false);
          this.addEventListener('timeout', function () {
            try { self.__gcDiagError = 'timeout'; } catch (e) {}
          }, false);
          this.addEventListener('abort', function () {
            try { self.__gcDiagError = 'abort'; } catch (e) {}
          }, false);
          this.addEventListener('loadend', function () {
            var reqId = 0;
            try { reqId = self.__gcDiagId; } catch (e) {}
            if (!reqId) return;
            var status = 0;
            try { status = Number(self.status) || 0; } catch (e) {}
            var err = '';
            try { err = self.__gcDiagError || ''; } catch (e) {}
            // `file://` XHR reports status 0 on success, so 0 alone is not an
            // error; only an explicit error/timeout/abort event is.
            var ok = !err && (status === 0 || (status >= 200 && status < 400));
            var info = diagXhrByteInfo(self);
            // Task 13: on an abort there is no response; keep the line's
            // `bytes=-1 src=null len=-1` rather than a misleading `src=text`.
            if (err) info = null;
            diagFinishPending(reqId, ok, status, info ? info.bytes : -1, err, info);
            try { self.__gcDiagId = 0; } catch (e) {}
          }, false);
        }
      } catch (e) {}

      try {
        return originalSend.apply(this, arguments);
      } catch (e) {
        if (id) diagFinishPending(id, false, 0, -1, (e && e.name) ? String(e.name) : 'throw');
        throw e;
      }
    };
  }

  /** `fetch` tracing: same promise semantics, with a pending entry around it. */
  function diagInstallFetchProbe() {
    if (!win || typeof win.fetch !== 'function') return;
    var originalFetch = win.fetch;
    win.fetch = function (input) {
      var url = '';
      try {
        if (typeof input === 'string') url = input;
        else if (input && typeof input.url === 'string') url = input.url;
      } catch (e) {}
      var id = diagStartPending('fetch', url, '');
      var promise;
      try {
        promise = originalFetch.apply(win, arguments);
      } catch (e) {
        diagFinishPending(id, false, 0, -1, (e && e.name) ? String(e.name) : 'throw');
        throw e;
      }
      if (!promise || typeof promise.then !== 'function') return promise;
      return promise.then(function (response) {
        var status = 0;
        var bytes = -1;
        try { status = Number(response && response.status) || 0; } catch (e) {}
        try {
          if (response && response.headers && typeof response.headers.get === 'function') {
            var length = response.headers.get('content-length');
            if (length !== null && length !== undefined) {
              var n = Number(length);
              if (!isNaN(n)) bytes = n;
            }
          }
        } catch (e) {}
        diagFinishPending(id, true, status, bytes, '');
        return response;
      }, function (error) {
        diagFinishPending(id, false, 0, -1, (error && error.name) ? String(error.name) : 'reject');
        throw error;
      });
    };
  }

  /** Append one resource entry to the bounded ring, log only if it is big/slow. */
  function diagRecordResource(entry) {
    var item = { name: '', type: '', start: 0, duration: 0, size: -1 };
    try { item.name = String(entry.name || ''); } catch (e) {}
    try { item.type = String(entry.initiatorType || ''); } catch (e) {}
    try { item.start = Number(entry.startTime) || 0; } catch (e) {}
    try { item.duration = Number(entry.duration) || 0; } catch (e) {}
    try {
      item.size = Number(entry.transferSize);
      if (isNaN(item.size)) item.size = -1;
    } catch (e) { item.size = -1; }

    diagState.resources.push(item);
    while (diagState.resources.length > DIAG_RESOURCE_RING) diagState.resources.shift();

    if (item.duration > DIAG_SLOW_MS || item.size > DIAG_BIG_RESOURCE) {
      diagWrite('RES type=' + item.type + ' dur=' + item.duration + ' size=' + item.size +
        ' start=' + item.start + ' name=' + item.name);
    }
  }

  function diagInstallPerformanceProbe() {
    var Observer = null;
    try { Observer = win && win.PerformanceObserver; } catch (e) {}
    if (typeof Observer !== 'function') return;
    try {
      var observer = new Observer(function (list) {
        try {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i++) diagRecordResource(entries[i]);
        } catch (e) {}
      });
      try {
        observer.observe({ type: 'resource', buffered: true });
      } catch (e1) {
        // Older implementations reject the `type` form; `entryTypes` still
        // works, just without `buffered`.
        try { observer.observe({ entryTypes: ['resource'] }); } catch (e2) {}
      }
    } catch (e) {}
  }

  function diagCanvasFacts() {
    var out = [];
    try {
      var nodes = (win.document && win.document.getElementsByTagName) ?
        win.document.getElementsByTagName('canvas') : null;
      for (var i = 0; nodes && i < nodes.length; i++) {
        var canvas = nodes[i];
        var size = diagCanvasSize(canvas);
        var isGl = false;
        var type = '';
        try { isGl = !!canvas.__gcDiagGl; } catch (e) {}
        for (var j = 0; j < diagState.glContexts.length; j++) {
          if (diagState.glContexts[j].canvas === canvas) {
            type = diagState.glContexts[j].type;
            break;
          }
        }
        out.push({ width: size.w, height: size.h, webgl: isGl, context: type });
      }
    } catch (e) {}
    return out;
  }

  function diagGlLimits() {
    var out = { maxTexture: -1, maxRenderbuffer: -1, maxTextureUnits: -1 };
    if (diagState.glContexts.length === 0) return out;
    var gl = diagState.glContexts[0].ctx;
    try { out.maxTexture = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)); } catch (e) {}
    try { out.maxRenderbuffer = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)); } catch (e) {}
    try { out.maxTextureUnits = Number(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)); } catch (e) {}
    return out;
  }

  function diagPageFacts() {
    var out = {
      dpr: 1,
      innerWidth: 0,
      innerHeight: 0,
      visibility: 'unknown',
      canvases: diagCanvasFacts(),
      gl: diagGlLimits()
    };
    try { out.dpr = Number(win.devicePixelRatio) || 1; } catch (e) {}
    try { out.innerWidth = Number(win.innerWidth) || 0; } catch (e) {}
    try { out.innerHeight = Number(win.innerHeight) || 0; } catch (e) {}
    try { out.visibility = String(win.document.visibilityState || 'unknown'); } catch (e) {}
    return out;
  }

  /**
   * The page facts the fix decision needs, logged once (at `load`, or at +10 s
   * if `load` never fires). A STALL record carries the same facts again.
   */
  function diagLogFacts(reason) {
    if (diagState.factsLogged) return;
    diagState.factsLogged = true;
    var facts = diagPageFacts();
    var gl = facts.gl;
    diagWrite('FACTS why=' + reason + ' dpr=' + facts.dpr +
      ' inner=' + facts.innerWidth + 'x' + facts.innerHeight +
      ' vis=' + facts.visibility +
      ' canvases=' + JSON.stringify(facts.canvases) +
      ' maxTexture=' + gl.maxTexture +
      ' maxRenderbuffer=' + gl.maxRenderbuffer +
      ' maxTextureUnits=' + gl.maxTextureUnits);
  }

  /** The compact counter object polled by the native heartbeat. */
  function diagCounters() {
    var audio = diagAudioFacts();
    var out = {
      rafSched: diagState.rafSched,
      rafFired: diagState.rafFired,
      ctxLost: diagState.ctxLost,
      ctxRestored: diagState.ctxRestored,
      ctxCreateErr: diagState.ctxCreateErr,
      ctxLostPrevented: diagState.ctxLostPrevented,
      audPlay: diagState.audPlay,
      absStart: diagState.absStart,
      absStop: diagState.absStop,
      draws: diagState.draws,
      clear: diagState.clear,
      texUp: diagState.texUp,
      readPx: diagState.readPx,
      bufData: diagState.bufData,
      ctxTime: audio.ctxTime,
      pend: diagState.pendingCount,
      audioElements: audio.elements,
      audioPaused: audio.paused,
      audioMaxTime: audio.maxTime,
      audioEnded: audio.ended,
      audioContexts: audio.contexts,
      visibility: 'unknown'
    };
    try { out.visibility = String(win.document.visibilityState || 'unknown'); } catch (e) {}
    return out;
  }

  /**
   * Best-effort read of the engine's own progress counters. Every field is
   * guarded and falls back to `null`, so a renamed/absent engine symbol never
   * fails the dump. Laya is the engine; `os.enterFrameCount` was seen in its
   * source, and `Laya.loader` may expose progress while a resource is pending.
   */
  function diagEngineFacts() {
    var out = { enterFrameCount: null, platform: null, layaVersion: null, loaderProgress: null };
    try {
      if (win.os) {
        if (win.os.enterFrameCount !== undefined) out.enterFrameCount = win.os.enterFrameCount;
        if (win.os.platform !== undefined) out.platform = win.os.platform;
      }
    } catch (e) {}
    try {
      if (win.Laya) {
        if (win.Laya.version !== undefined && win.Laya.version !== null) {
          out.layaVersion = String(win.Laya.version);
        }
        var loader = win.Laya.loader;
        if (loader) {
          if (loader.progress !== undefined) out.loaderProgress = loader.progress;
          else if (loader._progress !== undefined) out.loaderProgress = loader._progress;
        }
      }
    } catch (e) {}
    return out;
  }

  function diagPendingList() {
    var out = [];
    for (var key in diagState.pending) {
      if (!Object.prototype.hasOwnProperty.call(diagState.pending, key)) continue;
      var req = diagState.pending[key];
      if (!req) continue;
      out.push({
        id: Number(key),
        kind: req.kind,
        method: req.method,
        url: req.url,
        ms: diagNow() - req.startedAt
      });
    }
    return out;
  }

  /** The full on-demand payload: counters, page facts, pending table, ring. */
  function diagDump() {
    var out = {
      t: diagNow(),
      counters: diagCounters(),
      page: diagPageFacts(),
      engine: diagEngineFacts(),
      pending: diagPendingList(),
      resources: diagState.resources.slice(0)
    };
    var text;
    try {
      text = JSON.stringify(out);
    } catch (e) {
      text = '{"error":"dump failed"}';
    }
    return text;
  }

  /**
   * Volume-up hook: lose the engine's largest WebGL context, restore it 2 s
   * later. This build only *observes* what the engine does in between; it does
   * not try to help it recover.
   */
  function diagLoseContext() {
    var target = null;
    var bestArea = -1;
    for (var i = 0; i < diagState.glContexts.length; i++) {
      var item = diagState.glContexts[i];
      var size = diagCanvasSize(item.canvas);
      var area = size.w * size.h;
      if (area > bestArea) {
        bestArea = area;
        target = item;
      }
    }
    if (!target) return 'no-webgl';
    var ext = null;
    try { ext = target.ctx.getExtension('WEBGL_lose_context'); } catch (e) {}
    if (!ext || typeof ext.loseContext !== 'function') return 'no-extension';
    try {
      ext.loseContext();
      var tsize = diagCanvasSize(target.canvas);
      diagWrite('CTXSIM lost type=' + target.type + ' canvas=' + tsize.w + 'x' + tsize.h);
    } catch (e) {
      return 'lose-failed:' + ((e && e.name) ? String(e.name) : 'error');
    }
    diagSetTimeout(function () {
      try {
        if (typeof ext.restoreContext === 'function') {
          ext.restoreContext();
          diagWrite('CTXSIM restored');
        }
      } catch (e) {
        diagWrite('CTXSIM restore-failed ' + ((e && e.name) ? String(e.name) : 'error'));
      }
    }, 2000);
    return 'lost';
  }

  function diagInstallVisibilityProbe() {
    try {
      if (win.document && typeof win.document.addEventListener === 'function') {
        win.document.addEventListener('visibilitychange', function () {
          var state = 'unknown';
          try { state = String(win.document.visibilityState || 'unknown'); } catch (e) {}
          diagWrite('VIS visibility=' + state);
        }, false);
      }
    } catch (e) {}
    try {
      if (typeof win.addEventListener === 'function') {
        win.addEventListener('focus', function () { diagWrite('VIS focus'); }, false);
        win.addEventListener('blur', function () { diagWrite('VIS blur'); }, false);
      }
    } catch (e) {}
  }

  /**
   * Install the page-side liveness probe, once, when the flag is set:
   *
   *  - `window.__gcHeartbeat++` every 250 ms, which the native watchdog polls
   *    with `evaluateJavascript`. A heartbeat that keeps advancing while the
   *    picture is frozen is H3 (the engine's own loop stopped); a heartbeat
   *    that stops while the process lives is H1/H2.
   *  - `error` / `unhandledrejection` listeners that log message, file, line
   *    and column, so an exception that killed the engine's tick chain is on
   *    disk rather than in a devtools console nobody can open.
   */
  function installDiagnostics() {
    if (!diagEnabled()) return;

    try {
      if (typeof win.__gcHeartbeat === 'undefined') win.__gcHeartbeat = 0;
    } catch (e) {
      // A frozen window property is not worth failing the boot for.
    }

    try {
      if (typeof win.setInterval === 'function') {
        win.setInterval(function () {
          try {
            win.__gcHeartbeat = (win.__gcHeartbeat || 0) + 1;
          } catch (e) {
            // Ignore: the counter is best-effort.
          }
        }, 250);
      }
    } catch (e) {
      // Without an interval the native side simply sees a constant heartbeat.
    }

    try {
      if (win.addEventListener) {
        win.addEventListener('error', function (event) {
          var msg = 'unknown error';
          var file = '';
          var line = 0;
          var col = 0;
          try {
            if (event) {
              if (event.message !== undefined && event.message !== null) msg = String(event.message);
              file = String(event.filename == null ? '' : event.filename);
              line = event.lineno == null ? 0 : event.lineno;
              col = event.colno == null ? 0 : event.colno;
            }
          } catch (e) {}
          diagWrite('JSERR ' + msg + ' @ ' + file + ':' + line + ':' + col);
        }, false);
        win.addEventListener('unhandledrejection', function (event) {
          var reason = '';
          try {
            var r = event ? event.reason : null;
            if (r && r.message !== undefined) reason = String(r.message);
            else if (r !== undefined && r !== null) reason = String(r);
          } catch (e) {}
          diagWrite('JSREJECT ' + reason);
        }, false);
      }
    } catch (e) {
      // A host without addEventListener gets no page-side error capture.
    }

    /* ---- Task 12 probes: all of them are no-ops unless we got here ---- */
    try { diagInstallRafProbe(); } catch (e) {}
    try { diagInstallContextProbe(); } catch (e) {}
    try { diagInstallAudioProbe(); } catch (e) {}
    try { diagInstallXhrProbe(); } catch (e) {}
    try { diagInstallFetchProbe(); } catch (e) {}
    try { diagInstallPerformanceProbe(); } catch (e) {}
    try { diagInstallVisibilityProbe(); } catch (e) {}

    /* ---- Task 13 probes ---- */
    try { diagInstallDrawProbe(); } catch (e) {}

    // Page facts once the engine has had a chance to build its canvas.
    try {
      if (typeof win.addEventListener === 'function') {
        win.addEventListener('load', function () { diagLogFacts('load'); }, false);
      }
    } catch (e) {}
    diagScheduleRafNeverUsed();
    var factsTimer = diagSetTimeout(function () { diagLogFacts('t+10s'); }, 10000);
    try { if (factsTimer && typeof factsTimer.unref === 'function') factsTimer.unref(); } catch (e) {}

    // Task 13: arm one framebuffer sample at t+8/16/30 s. The reads happen in
    // the engine's rAF frames (see diagRunCanvasSample) and give a time series
    // across the title → loading → black transition, with no user action.
    var fbDelays = [8000, 16000, 30000];
    for (var fbi = 0; fbi < fbDelays.length; fbi++) {
      (function (ms) {
        var t = diagSetTimeout(function () { diagRequestCanvasSample('t+' + (ms / 1000) + 's'); }, ms);
        try { if (t && typeof t.unref === 'function') t.unref(); } catch (e) {}
      })(fbDelays[fbi]);
    }

    // The on-demand entry points the Activity's volume keys / STALL path call.
    win.__gcDiagDump = diagDump;
    win.__gcDiagCounters = diagCounters;
    win.__gcDiagLoseContext = diagLoseContext;
    win.__gcDiagSampleCanvas = diagRequestCanvasSample;

    diagWrite('DIAG on heartbeat=250ms flag=__gcDiag pack=v3');
  }

  /**
   * Call a host method, absorbing any host-side throw into `undefined`.
   *
   * The arity matters on Android: `@JavascriptInterface` binds methods by name
   * *and* parameter count, so calling a zero-argument host method with an
   * extra `undefined` would miss the binding and throw. The no-argument branch
   * below is therefore not cosmetic.
   *
   * ### Task 11 black-screen diagnostics
   *
   * When `window.__gcDiag === true` (set by `MainActivity` before the page
   * loads), every host round trip is bracketed with two lines written straight
   * to `host.log`:
   *
   *   CALL <name> args=<bytes>        — written *before* the host runs
   *   DONE <name> ok=<bool> ret=<bytes> ms=<n>
   *
   * and a `BIG <name> dir=<args|ret> bytes=<n>` warning whenever one payload
   * exceeds 4 MB. The point of writing `CALL` first is H2: if the JS thread
   * parks inside a host call, the last line on disk is a `CALL` with no
   * `DONE`, which names the blocking call without any further instrumentation.
   *
   * `args`/`ret` are payload lengths in characters. The payloads this bridge
   * actually carries are POSIX paths and base64 blobs, both ASCII, so one
   * character is one byte — and counting characters keeps the probe O(1)
   * instead of walking a 32-million-character font string, i.e. it cannot
   * itself perturb the timing it exists to measure.
   *
   * The flag is read on every call, never cached, and the whole block is a
   * no-op when it is absent — the shipped shim is byte-for-byte the same code
   * path.
   */
  function hostCall(name, arg1, arg2) {
    var diag = diagEnabled();
    if (diag) {
      var args = 0;
      if (arguments.length > 1) args += diagSize(arg1);
      if (arguments.length > 2) args += diagSize(arg2);
      diagWrite('CALL ' + name + ' args=' + args);
      diagBig(name, 'args', args);
    }

    if (!host || typeof host[name] !== 'function') {
      if (diag) diagWrite('DONE ' + name + ' ok=false ret=0 ms=0 err=missing');
      return undefined;
    }

    var started = diag ? diagNow() : 0;
    var result;
    try {
      if (arguments.length <= 1) result = host[name]();
      else if (arg2 === undefined) result = host[name](arg1);
      else result = host[name](arg1, arg2);
    } catch (e) {
      if (diag) diagWrite('DONE ' + name + ' ok=false ret=0 ms=' + (diagNow() - started) + ' err=throw');
      return undefined;
    }

    if (diag) {
      var ret = diagSize(result);
      diagWrite('DONE ' + name + ' ok=true ret=' + ret + ' ms=' + (diagNow() - started));
      diagBig(name, 'ret', ret);
    }
    return result;
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

  /**
   * Minimal stream pair. The engine uses streams for file copies
   * (`readable.pipe(writable)`) and for its trace log
   * (`createWriteStream(...).on('finish', cb)`); a waiting `SyncTask` resumes
   * only when that event fires. Events are deferred one macrotask, like
   * Node's, so a listener registered immediately after `pipe()` / `end()`
   * still sees them. The read side is served by the same synchronous
   * `readFileSync` the rest of the shim uses; the write side only emits the
   * lifecycle events, because the host's write path is a no-op.
   */
  function makeEmitter() {
    var listeners = {};
    return {
      on: function (event, listener) {
        var key = String(event);
        if (typeof listener === 'function') {
          (listeners[key] || (listeners[key] = [])).push(listener);
        }
        return this;
      },
      emit: function (event) {
        var list = listeners[String(event)];
        if (!list) return false;
        var args = Array.prototype.slice.call(arguments, 1);
        for (var i = 0; i < list.length; i++) list[i].apply(null, args);
        return true;
      }
    };
  }

  function makeReadStream(p) {
    var stream = makeEmitter();
    stream.pipe = function (dest) {
      defer(function () {
        var bytes;
        try {
          bytes = fsModule.readFileSync(p);
        } catch (err) {
          stream.emit('error', err);
          return;
        }
        stream.emit('data', bytes);
        if (dest && typeof dest.write === 'function') dest.write(bytes);
        if (dest && typeof dest.end === 'function') dest.end();
        stream.emit('end');
      });
      return dest;
    };
    return stream;
  }

  function makeWriteStream() {
    var stream = makeEmitter();
    stream.write = function () { return true; };
    stream.end = function () {
      defer(function () {
        stream.emit('finish');
        stream.emit('close');
      });
      return stream;
    };
    return stream;
  }

  var fsModule = {
    constants: {
      F_OK: 0,
      X_OK: 1,
      W_OK: 2,
      R_OK: 4
    },

    existsSync: function (p) {
      try {
        var abs = resolvePath(p);
        if (isWallpaperPath(abs)) return wallpaperBase64() !== null;
        return hostCall('exists', abs) === true;
      } catch (e) {
        return false;
      }
    },

    readFileSync: function (p, options) {
      var abs = resolvePath(p);
      if (isWallpaperPath(abs)) {
        var wallpaper = wallpaperBase64();
        if (wallpaper === null) throw fsError('ENOENT', 'open', abs);
        var wbytes = toBuffer(wallpaper);
        var wenc = canonicalEncoding(parseEncoding(options));
        return (wenc === null) ? wbytes : decodeWith(wenc, wbytes);
      }
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
      if (isWallpaperPath(abs)) {
        if (wallpaperBase64() === null) throw fsError('ENOENT', 'scandir', abs);
        if (!isWallpaperDir(abs)) throw fsError('ENOTDIR', 'scandir', abs);
        return [WALLPAPER_ENTRY];
      }
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
      if (isWallpaperPath(abs)) {
        if (wallpaperBase64() === null) throw fsError('ENOENT', 'stat', abs);
        return makeStats({ isDirectory: isWallpaperDir(abs), size: 0 });
      }
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

    /**
     * `access`/`accessSync` are used only as a readability / writability probe
     * (`fs.constants.F_OK | R_OK`, `W_OK`). The host exposes reachability only,
     * so existence is the whole test: a file that exists is reported readable,
     * and — because the write path is a no-op on this host — writable too.
     */
    accessSync: function (p, mode) {
      var abs = resolvePath(p);
      if (isWallpaperPath(abs)) {
        if (wallpaperBase64() === null) throw fsError('ENOENT', 'access', abs);
        return undefined;
      }
      if (!isWithinRoots(abs)) throw fsError('EACCES', 'access', abs);
      if (hostCall('exists', abs) !== true) throw fsError('ENOENT', 'access', abs);
      return undefined;
    },

    access: function (p, mode, cb) {
      if (typeof mode === 'function') { cb = mode; mode = undefined; }
      if (typeof cb !== 'function') return undefined;
      defer(function () {
        try {
          fsModule.accessSync(p, mode);
        } catch (err) {
          cb(err);
          return;
        }
        cb(null);
      });
      return undefined;
    },

    /**
     * `copyFileSync` is built from the two primitives that exist, so it keeps
     * Node's `ENOENT`-on-missing-source contract and lands the (no-op) write.
     */
    copyFileSync: function (src, dst) {
      var bytes = fsModule.readFileSync(src);
      fsModule.writeFileSync(dst, bytes);
      return undefined;
    },

    /**
     * `renameSync` / `rmdirSync` reach the host (`rename` / `rmdir`), so on
     * Android they become real operations (`File.renameTo` / `File.delete`)
     * rather than silent no-ops: a "successful" rename that moves nothing
     * would lose or corrupt saves during rotation. A `false` host reply is
     * turned into Node's error for the same syscall (Ruling 6), chosen from the
     * same host primitives every other member uses.
     */
    renameSync: function (oldPath, newPath) {
      var from = resolvePath(oldPath);
      var to = resolvePath(newPath);
      if (!isWithinRoots(from)) throw fsError('EACCES', 'rename', from);
      if (!isWithinRoots(to)) throw fsError('EACCES', 'rename', to);
      if (hostCall('rename', from, to) === true) return undefined;
      // The host refused (or offers no `rename`): report what Node would.
      if (hostCall('exists', from) !== true) throw fsError('ENOENT', 'rename', from);
      throw fsError('EACCES', 'rename', from);
    },

    rmdirSync: function (p) {
      var abs = resolvePath(p);
      if (!isWithinRoots(abs)) throw fsError('EACCES', 'rmdir', abs);
      if (hostCall('rmdir', abs) === true) return undefined;
      // Classify the refusal the way Node does.
      var info = parseStat(hostCall('stat', abs));
      if (!info) throw fsError('ENOENT', 'rmdir', abs);
      if (!info.isDirectory) throw fsError('ENOTDIR', 'rmdir', abs);
      var names = null;
      try {
        names = fsModule.readdirSync(abs);
      } catch (e) {
        names = null;
      }
      if (names && names.length > 0) throw fsError('ENOTEMPTY', 'rmdir', abs);
      throw fsError('EACCES', 'rmdir', abs);
    },

    createReadStream: makeReadStream,
    createWriteStream: makeWriteStream,

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
    },

    rename: function (oldPath, newPath, cb) {
      if (typeof cb !== 'function') return undefined;
      defer(function () {
        try {
          fsModule.renameSync(oldPath, newPath);
        } catch (err) {
          cb(err);
          return;
        }
        cb(null);
      });
      return undefined;
    },

    rmdir: function (p, cb) {
      if (typeof cb !== 'function') return undefined;
      defer(function () {
        try {
          fsModule.rmdirSync(p);
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

  /**
   * Every token of a command line, quotes stripped: `"a b" c` → `['a b', 'c']`.
   *
   * Quoting survives as one token, so a *whole argument* can be compared —
   * unlike `lower.indexOf(...)`, which also matches inside a message body.
   */
  function commandTokens(text) {
    var out = [];
    var re = /"([^"]*)"|(\S+)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      out.push(m[1] !== undefined ? m[1] : m[2]);
    }
    return out;
  }

  /**
   * Join the pieces of a notification body in order, skipping missing/empty
   * ones, so an abbreviated command form still yields sensible text.
   */
  function joinText(parts) {
    var kept = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part !== undefined && part !== null && String(part) !== '') {
        kept.push(String(part));
      }
    }
    return kept.join(' ');
  }

  /**
   * The user-visible text of a popup launched through `child_process`, taken by
   * *position*.
   *
   * The engine's command forms are fixed (see the Task 4 report):
   *   trayballoon.exe "<title>" "<content>" "<time>" "<iconType>" "<iconPath>"
   *   nircmd.exe "infobox" "<content>" "<title>"
   *   nircmd.exe "qboxcom" "<content>" "<title>" consolewrite yes
   * so `quotedArgs` yields either `[exe, title, content, …]` or
   * `[exe, messageType, content, title]`. Dropping the exe at index 0 and reading
   * the known positions cannot touch the message text itself — an earlier
   * shape-based filter ("contains a slash", "ends in .exe/.com") ate any body
   * that was a fraction, a date, a path joke or a URL.
   */
  function popupTextFromArgs(args) {
    var rest = Array.prototype.slice.call(args, 1); // drop the exe at index 0
    var kind = rest.length > 0 ? String(rest[0]).toLowerCase() : '';
    if (kind === 'qboxcom' || kind === 'infobox') {
      return joinText([rest[1], rest[2]]); // messageType, content, title
    }
    return joinText([rest[0], rest[1]]); // trayballoon: title, content
  }

  /** True when a command is one of the engine's popups (tray balloon / box). */
  function isPopupCommand(lower, tokens) {
    if (lower.indexOf('trayballoon') !== -1) return true;
    if (lower.indexOf('nircmd') === -1) return false;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i].toLowerCase();
      if (t === 'infobox' || t === 'qboxcom') return true;
    }
    return false;
  }

  /**
   * True for the nircmd *question* box (`qboxcom`) that writes the player's
   * answer to stdout. `infobox` and `trayballoon` are announcements with no
   * answer, so they must not block on a dialog.
   */
  function isQuestionCommand(lower, tokens) {
    if (lower.indexOf('nircmd') === -1) return false;
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i].toLowerCase() === 'qboxcom') return true;
    }
    return false;
  }

  /**
   * True when a whole token is an OS power verb.
   *
   * Matching a *token* (not the raw command) is deliberate: the engine sends
   * `nircmd.exe hibernate` and `nircmd.exe "shutdown"`, so the verb can be bare
   * or quoted, but a message body that merely contains the word "shutdown"
   * must never be mistaken for one — quitting the app mid-performance is far
   * worse than a bad toast.
   */
  function isPowerVerb(token) {
    return /^(shutdown|hibernate|exitwin|poweroff)$/i.test(token);
  }

  /** True when any argument of a command is a power verb. */
  function hasPowerVerb(tokens) {
    for (var i = 0; i < tokens.length; i++) {
      if (isPowerVerb(tokens[i])) return true;
    }
    return false;
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
    var tokens = commandTokens(text);

    // "read the player's real account name" — the first Meta performance.
    // `W26_WindowsFullName.fullName` takes line 2 of the output, so the shape
    // has to stay wmic-like. ASCII only: the engine GBK-decodes this buffer.
    if (lower.indexOf('wmic useraccount') !== -1) {
      return 'FullName\n\n' + asciiOnly(hostString('deviceName'));
    }

    // "read the Windows version" — also GBK-decoded, so ASCII only. The value
    // must sit on line index 2: `W26_TraceConsole.handleInfo` starts reading at
    // `split("\n")[2]` and skips blank lines, a plain one-line reply would be
    // discarded.
    if (lower.indexOf('wmic os get caption') !== -1) {
      return '\n\nAndroid ' + asciiOnly(hostString('androidVersion'));
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
      // The desktop wallpaper just changed; the cached read is now stale.
      invalidateWallpaperCache();
      return '';
    }

    // "pop a tray balloon", and the nircmd message boxes: a toast/notification.
    // Checked *before* the power verbs on purpose: a box whose body happens to
    // contain "shutdown" is still a box, and only the popup text is quoted.
    if (isPopupCommand(lower, tokens)) {
      var popupArgs = quotedArgs(text);
      hostCall('toast', popupTextFromArgs(popupArgs));
      if (isQuestionCommand(lower, tokens)) {
        // `qboxcom … consolewrite yes`: the engine's `showMessage_yes` reads the
        // answer back from stdout and proceeds only on `"yes"`. Anything but an
        // explicit yes — including "no" — must be the empty string, so the
        // engine treats it as a decline.
        var rest = Array.prototype.slice.call(popupArgs, 1); // drop the exe
        var body = rest.length > 1 ? rest[1] : ''; // [kind, content, title]
        var title = rest.length > 2 ? rest[2] : '';
        return hostCall('confirm', String(title), String(body)) === true ? 'yes' : '';
      }
      return '';
    }

    // "shut down the computer": the full game runs `nircmd.exe shutdown`, this
    // Demo build's power-off command is `nircmd.exe hibernate` (customCommand_15033).
    // Either way Android plays the black-screen performance and quits the app —
    // it never really powers the device off. The verb is matched as a token, so
    // the word inside some other argument cannot trigger it.
    if (lower.indexOf('nircmd') !== -1 && hasPowerVerb(tokens)) {
      hostCall('fakeShutdown');
      return '';
    }

    // "switch the monitor off" — `W26_VisualSysOpt.offMonitor` runs
    // `"<SystemRoot>\system32\scrnsave.scr" /s`. Android has no screensaver, so
    // the host dims the window instead; the trace-console log line stays so the
    // performance still leaves a trace (it is genuinely a no-op otherwise).
    if (lower.indexOf('scrnsave') !== -1) {
      hostCall('screenOff');
      hostCall('log', text);
      return '';
    }

    // Everything else is Windows-only plumbing: the wmic system-info queries
    // behind the trace console, nvidia-smi, and rundll32.
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
        // Android equivalent is a notification. Unlike the `exec` forms, the exe
        // is a separate argument here, so the args are already [content, title, …].
        var parts = Array.isArray(args) ? args : [];
        hostCall('toast', joinText([parts[0], parts[1]]));
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
   * `Buffer`
   *
   * The engine's bundled Live2D WAsm loader decodes an embedded base64
   * data-URI with `Buffer.from(str, 'base64')`. It reaches the global through
   * `_getAttributeFromParentPages('Buffer')` (i.e. `globalThis.Buffer`), and
   * feeds the result to `Uint8Array`/`fs.writeFile`, so a plain `Uint8Array`
   * satisfies it: the loader only reads `.buffer`, `.byteOffset` and
   * `.byteLength`, all present on a typed array. Node's `Buffer` is a
   * `Uint8Array` subclass, so this is a faithful subset.
   * ------------------------------------------------------------------ */

  function BufferShim(value, encoding) {
    if (typeof value === 'string') {
      var enc = canonicalEncoding(encoding);
      if (enc === 'base64') return toBuffer(value);
      if (enc === 'latin1') return latin1Encode(value);
      if (enc === 'ascii') return asciiEncode(value);
      return utf8Encode(value);
    }
    return BufferShim.from(value);
  }

  BufferShim.from = function (data, encoding) {
    if (typeof data === 'string') return BufferShim(data, encoding);
    if (data === null || data === undefined) return new Uint8Array(0);
    if (typeof Uint8Array !== 'undefined' && data instanceof Uint8Array) {
      var copy = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) copy[i] = data[i];
      return copy;
    }
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
      return new Uint8Array(data.slice(0));
    }
    if (typeof data.length === 'number') {
      var out = new Uint8Array(data.length);
      for (var j = 0; j < data.length; j++) out[j] = data[j] & 0xff;
      return out;
    }
    throw new TypeError('Buffer.from: unsupported input type');
  };

  BufferShim.alloc = function (size) {
    return new Uint8Array(size || 0);
  };

  BufferShim.allocUnsafe = function (size) {
    return new Uint8Array(size || 0);
  };

  BufferShim.isBuffer = function (value) {
    return (typeof Uint8Array !== 'undefined') && (value instanceof Uint8Array);
  };

  BufferShim.byteLength = function (value, encoding) {
    if (typeof value === 'string') return BufferShim(value, encoding).length;
    return value ? value.length : 0;
  };

  BufferShim.concat = function (list, totalLength) {
    var items = list || [];
    var total = totalLength;
    var k;
    if (total === undefined) {
      total = 0;
      for (k = 0; k < items.length; k++) total += items[k].length;
    }
    var result = new Uint8Array(total);
    var offset = 0;
    for (k = 0; k < items.length && offset < total; k++) {
      var part = items[k];
      var take = Math.min(part.length, total - offset);
      for (var m = 0; m < take; m++) result[offset + m] = part[m];
      offset += take;
    }
    return result;
  };

  /* ------------------------------------------------------------------ *
   * Desktop parity: Laya's `Browser.onPC`
   *
   * Two of the engine's file-system functions branch on `Browser.onPC` and
   * have no `else`, so the mobile path drops their completion callback:
   *
   *     FileUtils.createDirectoryForce = function (localURL, onFin, ...) {
   *         var taskF = function () {
   *             var onCreateDirectoryFin = Callback.New(function (success) {
   *                 onFin && onFin.runWith([success, localURL]);
   *                 if (taskLock)
   *                     SyncTask.taskOver(FileUtils.TASK_MODIFY_FILE);   // <- here
   *             }, this);
   *             ...
   *             if (Browser.onPC) {                                      // <- gate
   *                 ...
   *                 createDirectoryForce(fullURL, function () {
   *                     onCreateDirectoryFin.runWith([true, localURL]);     // <- dropped
   *                 }, ...);
   *             }
   *         };
   *         new SyncTask(FileUtils.TASK_MODIFY_FILE, taskF);
   *     };
   *
   * `FileUtils.saveFile` has the same shape ("else if (Browser.onPC) {
   * mainDomain_fs.writeFile(...) }").
   *
   * Laya sets `Browser.onPC = !Browser.onMobile`, and `onMobile` is true for
   * every phone user agent, so on Android the branch is skipped and
   * `SyncTask.taskOver(FileUtils.TASK_MODIFY_FILE)` never runs. The file-task
   * queue then jams on the first directory the engine tries to create: the
   * loading bundle still finishes (its loader is independent) and the
   * transition curtain is painted, but the default save write, the
   * fourth-wall gags and the first scene's BGM are all queued behind a lock
   * that is never released. The render loop keeps running against a black
   * screen forever, with no exception and no further host call.
   *
   * The demo only ever shipped for Windows, where `onPC` is true, so the
   * mobile branch is dead code that was never completed. Report desktop
   * parity instead. Only `onPC` is set: across the whole engine it is read in
   * exactly three places (those two branches and Laya's `TextInput` focus
   * call), while `Browser.onMobile` is what still drives Laya's touch input
   * binding on the device.
   * ------------------------------------------------------------------ */

  /**
   * `Browser.__init__` assigns `onPC` lazily - on the first `Browser.*` access,
   * and only once - which can happen after this script has run, so the value
   * is asserted on a timer rather than once. One property read per tick for
   * the life of the page; it gives up if Laya never appears.
   */
  function enforceDesktopPlatform() {
    if (typeof setInterval !== 'function') return;
    var idle = 0;
    var iv = setInterval(function () {
      var browser = null;
      try {
        browser = win && win.Laya && win.Laya.Browser;
      } catch (e) {
        return;
      }
      if (!browser) {
        // No Laya after a minute: not the game, stop watching.
        if (++idle > 240) clearInterval(iv);
        return;
      }
      idle = 0;
      try {
        if (browser.onPC === true) return;
        browser.onPC = true;
        if (diagEnabled()) diagWrite('Desktop parity: Browser.onPC forced true');
      } catch (e) {
        // A frozen browser record must not break the boot.
      }
    }, 250);
  }

  /* ------------------------------------------------------------------ *
   * Publish the NW.js-ish environment
   * ------------------------------------------------------------------ */

  if (win) {
    win.require = requireModule;
    win.process = processObject;
    win.Buffer = BufferShim;
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

    // Task 11: page-side instrumentation, only when the Activity opted in.
    installDiagnostics();

    // The mobile deadlock: `Browser.onPC` gates two engine branches that own
    // the file-task lock's release. See the section above.
    enforceDesktopPlatform();
  }
})();
