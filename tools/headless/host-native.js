'use strict';

/**
 * Native host for the headless harness.
 *
 * `createHost()` returns an object whose methods are name-for-name and
 * signature-for-signature identical to the Android `__GCNative` bridge
 * (see plan Task 3 Interfaces). That lets `gc-bridge.js` run unchanged in
 * Node/Playwright and on a real device.
 *
 * This host is the single authority for path resolution: it turns a
 * game-relative or absolute path into a real filesystem path and rejects
 * anything that escapes `gameRoot` or `docsRoot`. The bridge layer above it
 * only does Node-style concatenation and adds no second escape check.
 *
 * No method may ever throw across this boundary: failures return
 * `null` / `false` / `'[]'` instead.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Absolute path without a trailing slash (except for the root `/`). */
function normalizeRoot(p) {
  const abs = path.posix.resolve(String(p == null ? '' : p));
  return abs.length > 1 && abs.endsWith('/') ? abs.slice(0, -1) : abs;
}

/** True when `candidate` is `root` itself or lives underneath it. */
function isInside(root, candidate) {
  if (candidate === root) return true;
  const prefix = root === '/' ? '/' : root + '/';
  return candidate.startsWith(prefix);
}

function createHost(options) {
  const opts = options || {};
  const root = normalizeRoot(opts.gameRoot);
  const docs = normalizeRoot(opts.docsRoot);

  /**
   * Resolve a caller-supplied path to a real path, or `null` when it escapes
   * both roots. A path starting with `/` is absolute; anything else is
   * relative to `gameRoot`.
   */
  function toRealPath(p) {
    const raw = String(p == null ? '' : p);
    if (raw === '') return null;
    const abs = path.posix.resolve(root, raw);
    return isInside(root, abs) || isInside(docs, abs) ? abs : null;
  }

  function emit(kind, msg) {
    console.log('[host:' + kind + '] ' + msg);
  }

  return {
    gameRoot: function () {
      return root;
    },

    docsRoot: function () {
      return docs;
    },

    exists: function (p) {
      const abs = toRealPath(p);
      if (abs === null) return false;
      try {
        return fs.existsSync(abs);
      } catch (e) {
        return false;
      }
    },

    stat: function (p) {
      const abs = toRealPath(p);
      if (abs === null) return null;
      try {
        const st = fs.statSync(abs);
        return JSON.stringify({ isDirectory: st.isDirectory(), size: st.size });
      } catch (e) {
        return null;
      }
    },

    readBase64: function (p) {
      const abs = toRealPath(p);
      if (abs === null) return null;
      try {
        return fs.readFileSync(abs).toString('base64');
      } catch (e) {
        return null;
      }
    },

    writeBase64: function (p, b64) {
      const abs = toRealPath(p);
      if (abs === null) return false;
      try {
        fs.mkdirSync(path.posix.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(String(b64 == null ? '' : b64), 'base64'));
        return true;
      } catch (e) {
        return false;
      }
    },

    readDir: function (p) {
      const abs = toRealPath(p);
      if (abs === null) return '[]';
      try {
        return JSON.stringify(fs.readdirSync(abs));
      } catch (e) {
        return '[]';
      }
    },

    mkdirp: function (p) {
      const abs = toRealPath(p);
      if (abs === null) return false;
      try {
        fs.mkdirSync(abs, { recursive: true });
        return true;
      } catch (e) {
        return false;
      }
    },

    unlink: function (p) {
      const abs = toRealPath(p);
      if (abs === null) return false;
      try {
        fs.unlinkSync(abs);
        return true;
      } catch (e) {
        return false;
      }
    },

    deviceName: function () {
      return 'Headless Host';
    },

    androidVersion: function () {
      return '0';
    },

    setWallpaper: function (b64) {
      // No desktop to decorate in a headless run.
      return false;
    },

    toast: function (msg) {
      emit('toast', String(msg == null ? '' : msg));
    },

    fakeShutdown: function () {
      emit('shutdown', 'pretending to power off');
    },

    openFile: function (p) {
      emit('openFile', String(p == null ? '' : p));
      return false;
    },

    vibrate: function (ms) {
      emit('vibrate', String(ms == null ? '' : ms));
    },

    clipboardGet: function () {
      return '';
    },

    clipboardSet: function (s) {
      emit('clipboard', String(s == null ? '' : s));
    },

    log: function (s) {
      emit('log', String(s == null ? '' : s));
    },
  };
}

module.exports = { createHost };
