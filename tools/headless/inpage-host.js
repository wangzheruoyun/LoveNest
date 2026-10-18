/**
 * inpage-host.js — the `__GCNative` host, implemented *inside the page*.
 *
 * `run.js --inject` evaluates this script as a Playwright init script, before
 * any page script runs. It defines `window.__GCNative` with exactly the same
 * name-for-name, signature-for-signature surface as the Android
 * `GameBridge.kt` (see plan Task 3 Interfaces) and the Node-side
 * `tools/headless/host-native.js`.
 *
 * Why implement the host in-page instead of driving it from Node (Ruling 7):
 * the engine boots from a `file://` URL and its synchronous filesystem calls
 * (`fs.readFileSync` at load) must be *synchronous* inside the page. A
 * Playwright `page.exposeFunction` round trip is asynchronous, so it cannot
 * back `readFileSync`. A synchronous `XMLHttpRequest` against a `file://` URL
 * can, and Chromium serves it in the same process — no bridge hop.
 *
 * Capability split (Ruling 7):
 *   - read-only path: `exists` / `stat` / `readBase64` / `readDir` are backed
 *     by a synchronous `file://` XHR.
 *   - write path: `writeBase64` / `mkdirp` / `unlink` / `rename` / `rmdir` are
 *     logged no-ops that report success (`true`). The game folder must stay
 *     byte-identical (NOTES.md "Housekeeping"), and a headless run has no real
 *     save location to write to. That limitation is recorded in NOTES.md.
 *   - Android-only capabilities (`setWallpaper` / `toast` / `fakeShutdown` /
 *     `openFile` / `vibrate` / clipboard) become console log lines.
 *
 * This file is Node-side harness scratch, so it is *not* bound by the ES5
 * rule that `gc-bridge.js` must obey. It is written conservatively anyway
 * (`var` / `function`) so it behaves identically under old engines.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  var config = window.__GCNativeConfig || {};
  var gameRootPath = normalizeRoot(config.gameRoot || '');
  var docsRootPath = normalizeRoot(config.docsRoot || '');

  var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /* ------------------------------------------------------------------ *
   * POSIX path helpers (the host is the single path authority, so it
   * re-derives absolute paths the same way host-native.js does).
   * ------------------------------------------------------------------ */

  function normalizeRoot(p) {
    var s = String(p == null ? '' : p);
    var end = s.length;
    while (end > 1 && s.charAt(end - 1) === '/') end--;
    return s.slice(0, end);
  }

  function posixNormalize(p) {
    var s = String(p == null ? '' : p);
    var isAbs = s.charAt(0) === '/';
    var parts = s.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
        else if (!isAbs) out.push('..');
      } else {
        out.push(seg);
      }
    }
    var res = (isAbs ? '/' : '') + out.join('/');
    if (res === '') return isAbs ? '/' : '.';
    return res;
  }

  function dirnameOf(p) {
    var s = String(p == null ? '' : p);
    var idx = s.lastIndexOf('/');
    if (idx < 0) return '.';
    if (idx === 0) return '/';
    return s.slice(0, idx);
  }

  function basenameOf(p) {
    var s = String(p == null ? '' : p);
    var idx = s.lastIndexOf('/');
    return idx < 0 ? s : s.slice(idx + 1);
  }

  function isInside(root, candidate) {
    if (!root || root === '/') return true;
    return candidate === root || candidate.indexOf(root + '/') === 0;
  }

  /** Resolve to a host-absolute path, or `null` when it escapes both roots. */
  function resolveWithin(p) {
    var raw = String(p == null ? '' : p);
    if (raw === '') return null;
    var abs = (raw.charAt(0) === '/') ? posixNormalize(raw)
      : posixNormalize(gameRootPath + '/' + raw);
    if (isInside(gameRootPath, abs) || isInside(docsRootPath, abs)) return abs;
    return null;
  }

  /** `file://` URL for a host-absolute path, percent-escaping each segment. */
  function fileUrl(abs) {
    return 'file://' + abs.split('/').map(encodeURIComponent).join('/');
  }

  /* ------------------------------------------------------------------ *
   * Synchronous file:// XHR primitives
   *
   * A file GET returns 200 with the body. A missing file throws a
   * `NetworkError` out of `send()`. A directory returns status 0 with a
   * generated listing page whose body carries `addRow(...)` calls — the
   * same trick the harness uses to tell a directory apart from a file.
   * ------------------------------------------------------------------ */

  function rawGet(url) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    // `x-user-defined` keeps the body byte-for-byte: each byte becomes one
    // UTF-16 code unit, so `responseText.length` *is* the byte length (verified:
    // icon.png 2361 bytes → 2361, vs 2234 without the override). Directory
    // listings are ASCII so their `addRow(...)` parsing is unaffected.
    if (xhr.overrideMimeType) xhr.overrideMimeType('text/plain; charset=x-user-defined');
    try {
      xhr.send();
    } catch (e) {
      return { kind: 'missing' };
    }
    if (xhr.status === 200) return { kind: 'file', text: xhr.responseText };
    var body = xhr.responseText;
    if (xhr.status === 0 && typeof body === 'string' && body.length > 0) {
      return { kind: 'dir', text: body };
    }
    return { kind: 'missing' };
  }

  /**
   * Read a file's bytes and return base64, or `null`.
   *
   * `charset=x-user-defined` maps byte 0x80..0xFF to U+F780..U+F7FF, so
   * `charCodeAt(i) & 0xFF` recovers the original byte exactly (verified
   * against `icon.png`: byte-identical to Node's `.toString('base64')`).
   */
  function readBase64(abs) {
    var path = resolveWithin(abs);
    if (path === null) return null;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', fileUrl(path), false);
    if (xhr.overrideMimeType) xhr.overrideMimeType('text/plain; charset=x-user-defined');
    try {
      xhr.send();
    } catch (e) {
      return null;
    }
    if (xhr.status !== 200) return null;
    return encodeBase64(xhr.responseText);
  }

  /** Base64-encode a `x-user-defined` response string (low byte = byte). */
  function encodeBase64(s) {
    var out = '';
    var i = 0;
    for (; i + 2 < s.length; i += 3) {
      var n3 = ((s.charCodeAt(i) & 0xff) << 16) |
        ((s.charCodeAt(i + 1) & 0xff) << 8) |
        (s.charCodeAt(i + 2) & 0xff);
      out += B64_ALPHABET.charAt((n3 >> 18) & 63) +
        B64_ALPHABET.charAt((n3 >> 12) & 63) +
        B64_ALPHABET.charAt((n3 >> 6) & 63) +
        B64_ALPHABET.charAt(n3 & 63);
    }
    var rem = s.length - i;
    if (rem === 1) {
      var n1 = (s.charCodeAt(i) & 0xff) << 16;
      out += B64_ALPHABET.charAt((n1 >> 18) & 63) +
        B64_ALPHABET.charAt((n1 >> 12) & 63) + '==';
    } else if (rem === 2) {
      var n2 = ((s.charCodeAt(i) & 0xff) << 16) | ((s.charCodeAt(i + 1) & 0xff) << 8);
      out += B64_ALPHABET.charAt((n2 >> 18) & 63) +
        B64_ALPHABET.charAt((n2 >> 12) & 63) +
        B64_ALPHABET.charAt((n2 >> 6) & 63) + '=';
    }
    return out;
  }

  /** Unescape one `addRow` name argument (a JSON string body). */
  function unescapeName(escaped) {
    try {
      return JSON.parse('"' + escaped + '"');
    } catch (e) {
      return escaped;
    }
  }

  /** Find `name`'s row in a directory listing; `null` when absent. */
  function findEntry(listing, name) {
    var re = /addRow\("((?:[^"\\]|\\.)*)","[^"]*",([01]),(\d+)/g;
    var m;
    while ((m = re.exec(listing)) !== null) {
      if (unescapeName(m[1]) === name) {
        return { isDir: m[2] === '1', size: parseInt(m[3], 10) };
      }
    }
    return null;
  }

  function exists(abs) {
    var path = resolveWithin(abs);
    if (path === null) return false;
    if (path === gameRootPath || path === docsRootPath) return true;
    return rawGet(fileUrl(path)).kind !== 'missing';
  }

  function stat(abs) {
    var path = resolveWithin(abs);
    if (path === null) return null;
    if (path === gameRootPath || path === docsRootPath) {
      return JSON.stringify({ isDirectory: true, size: 0 });
    }
    // A directory lists itself; a file is a row in its parent's listing, which
    // is the only place the exact byte size is available.
    var self = rawGet(fileUrl(path));
    if (self.kind === 'dir') return JSON.stringify({ isDirectory: true, size: 0 });
    var listing = rawGet(fileUrl(dirnameOf(path)));
    if (listing.kind === 'dir') {
      var entry = findEntry(listing.text, basenameOf(path));
      if (entry) return JSON.stringify({ isDirectory: entry.isDir, size: entry.size });
    }
    if (self.kind === 'file') {
      // Invariant: `rawGet` opens with `charset=x-user-defined`, so the body is
      // one UTF-16 code unit per byte and `text.length` equals the byte length
      // (see `rawGet`). This fallback therefore reports a real byte size.
      return JSON.stringify({ isDirectory: false, size: self.text.length });
    }
    return null;
  }

  function readDir(abs) {
    var path = resolveWithin(abs);
    if (path === null) return '[]';
    var raw = rawGet(fileUrl(path));
    if (raw.kind !== 'dir') return '[]';
    var names = [];
    var re = /addRow\("((?:[^"\\]|\\.)*)"/g;
    var m;
    while ((m = re.exec(raw.text)) !== null) names.push(unescapeName(m[1]));
    return JSON.stringify(names);
  }

  /* ------------------------------------------------------------------ *
   * Write path: logged no-ops that report success.
   * ------------------------------------------------------------------ */

  function emit(kind, msg) {
    console.log('[host:' + kind + '] ' + msg);
  }

  function writeBase64(p, b64) {
    var path = resolveWithin(p);
    emit('write', 'no-op ' + (path === null ? String(p) : path) +
      ' (' + String(b64 == null ? '' : b64).length + ' b64 chars)');
    return path !== null;
  }

  function mkdirp(p) {
    var path = resolveWithin(p);
    emit('mkdirp', 'no-op ' + (path === null ? String(p) : path));
    return path !== null;
  }

  function unlink(p) {
    var path = resolveWithin(p);
    emit('unlink', 'no-op ' + (path === null ? String(p) : path));
    return path !== null;
  }

  function rename(p, to) {
    var path = resolveWithin(p);
    var target = resolveWithin(to);
    emit('rename', 'no-op ' + (path === null ? String(p) : path) +
      ' -> ' + (target === null ? String(to) : target));
    return path !== null && target !== null;
  }

  function rmdir(p) {
    var path = resolveWithin(p);
    emit('rmdir', 'no-op ' + (path === null ? String(p) : path));
    return path !== null;
  }

  /* ------------------------------------------------------------------ *
   * Android-only capabilities: console log lines.
   * ------------------------------------------------------------------ */

  function androidCapability(name) {
    return function (arg) {
      emit(name, String(arg == null ? '' : arg));
    };
  }

  var host = {
    gameRoot: function () { return gameRootPath; },
    docsRoot: function () { return docsRootPath; },

    exists: exists,
    stat: stat,
    readBase64: readBase64,
    readDir: readDir,

    writeBase64: writeBase64,
    mkdirp: mkdirp,
    unlink: unlink,
    rename: rename,
    rmdir: rmdir,

    deviceName: function () { return 'Pixel Owner'; },
    androidVersion: function () { return '14'; },

    setWallpaper: function (b64) { emit('setWallpaper', (b64 ? b64.length : 0) + ' b64 chars'); },
    toast: androidCapability('toast'),
    fakeShutdown: function () { emit('shutdown', 'pretending to power off'); },
    openFile: function (p) { emit('openFile', String(p == null ? '' : p)); return false; },
    vibrate: function (ms) { emit('vibrate', String(ms == null ? '' : ms)); },
    clipboardGet: function () { return ''; },
    clipboardSet: function (s) { emit('clipboard', String(s == null ? '' : s)); },
    log: function (s) { emit('log', String(s == null ? '' : s)); }
  };

  window.__GCNative = host;
  try {
    delete window.__GCNativeConfig;
  } catch (e) {
    window.__GCNativeConfig = undefined;
  }
})();
