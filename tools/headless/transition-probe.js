#!/usr/bin/env node
'use strict';

/**
 * Transition probe: what does the engine's own world look like at the instant
 * the phone goes black? (local diagnostic - never a gate, never in CI)
 *
 * The phone is alive and drawing ~1 full-screen quad per frame into an
 * all-zero framebuffer, with no clears and no new texture uploads, forever.
 * That is what a permanent full-screen black cover looks like - the engine has
 * painted its transition curtain and the step that was supposed to lift it
 * never ran. Every device-side instrument we have measures the *outside* of
 * that (framebuffer, draw calls, rAF cadence). None of them can say whether the
 * engine's own scene graph actually contains the first scene.
 *
 * This script asks the engine directly, in its own language:
 *
 *   1. Laya state - `Laya.stage` child count, a depth-limited walk of the scene
 *      graph (class, x/y, size, alpha, visible, texture present), the timer's
 *      delta/currFrame (the frame-delta theory), `Laya.Browser` metrics, and the
 *      engine's own `os.*` record.
 *   2. Control XHRs - issued by this script, from the same page, at the same
 *      moment, for the exact files the device log claimed came back empty
 *      (`asset/json/animation/data/ani*.json`). A control load that returns the
 *      full on-disk payload while the engine's own load returned nothing puts
 *      the fault in the engine's loader; a control load that is *also* empty
 *      puts it in the `file://` transport.
 *
 * The shim's own diagnostics are turned on (`window.__gcDiag = true`) so the
 * `REQ` lines here are the same lines the phone writes, and can be compared
 * line for line. Everything is read-only: the game folder is never written.
 *
 * Usage: node tools/headless/transition-probe.js [--seconds 60]
 * Env:   LOVENEST_GAME_ROOT, LOVENEST_DOCS_ROOT, LOVENEST_VIEWPORT,
 *        LOVENEST_BROWSER_ARGS (all as drive.js)
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const GAME_ROOT =
  process.env.LOVENEST_GAME_ROOT || '/storage/emulated/0/Download/爱之巢DemoV1.52';
const DOCS_ROOT = process.env.LOVENEST_DOCS_ROOT || '/tmp/opencode/lovenest-docs';
const OUT_DIR = path.join(__dirname, 'out');

const argv = process.argv.slice(2);
const secIdx = argv.indexOf('--seconds');
const TOTAL_MS = (secIdx !== -1 ? Number(argv[secIdx + 1]) : 60) * 1000;
// `--no-webgl` forces Laya onto its Canvas 2D renderer. Locally SwiftShader
// loses the engine's WebGL context ~2.6s in, which makes every late
// observation ambiguous: "the engine is stuck" and "the engine is stuck
// *because the context died*" look identical. With no WebGL to lose, a stall
// that survives is renderer-independent - i.e. the engine's own logic - and
// therefore a faithful reproduction of the phone.
const NO_WEBGL = argv.indexOf('--no-webgl') !== -1;
// `--btn-mode` controls how the three assets the Demo never shipped -
// `asset/image/picture/control/btn_over|click|normal.png` - are answered.
// The phone finishes its whole session with `btn_normal.png` as its very last
// request and not one XHR or host call afterwards, while its loop keeps
// running: the shape of a loader item that never completes. Locally the same
// three files 404 *cleanly* (an `error` event) and the engine walks straight
// past. `empty` reproduces the phone's anomalous answer (HTTP 200, zero bytes,
// no error event) to see whether that alone stalls the engine; `supply`
// answers with a real (resource-protected) PNG to see whether supplying them
// removes the stall. The game folder is never touched either way.
const btnIdx = argv.indexOf('--btn-mode');
const BTN_MODE = btnIdx !== -1 ? String(argv[btnIdx + 1]) : 'disk';
/**
 * `--worker-mode` targets the engine's own `Worker` use, which is the one thing
 * at the stall seam that leaves no trace in any of our instruments.
 *
 * `ObjectUtils.jsonSerialize` runs `useworker = !Config.EDIT_MODE`, so a release
 * build hands the save path to a blob worker built lazily from
 * `URL.createObjectURL(new Blob([ObjectUtils.workerCode]))`. That worker is
 * wired with **only `onmessage` - no `onerror`** - and `workJsonHandler` stores
 * the continuation in `_workerOnFins[key]` *before* it posts. A worker that
 * never replies therefore loses the continuation silently: no throw, no XHR, no
 * host call, and the engine's loop keeps running over a black cover. That is
 * the phone's exact signature.
 *
 *   `real` - untouched (control)
 *   `dead` - a Worker that constructs fine but never replies (the suspected
 *            Android `file://` behaviour)
 *   `none` - `window.Worker = undefined`, which forces the engine's synchronous
 *            `JSON.parse(JSON.stringify(o))` branch (the candidate fix)
 */
const wkIdx = argv.indexOf('--worker-mode');
const WORKER_MODE = wkIdx !== -1 ? String(argv[wkIdx + 1]) : 'real';
/**
 * `--patch-objectutils` installs the worker-free `ObjectUtils` replacement
 * (see `objectUtilsPatch`). Combined with `--worker-mode dead` this is the
 * decisive experiment: the patch must rescue an engine whose worker never
 * replies, which is the phone's suspected condition.
 */
const PATCH_OBJUTILS = argv.includes('--patch-objectutils');
// `--host-stack` (or LOVENEST_HOSTSTACK=1) wraps every `__GCNative` method so
// each host call records `new Error().stack`. The phone's engine goes silent
// after the loading bundle; a stack per call says *which* engine function owns
// that silence, without a device round-trip.
const HOST_STACK = argv.includes('--host-stack') || process.env.LOVENEST_HOSTSTACK === '1';
const PLATFORM_PROBE = argv.includes('--platform-probe');
/**
 * `--ua-mobile` reports the device's Android WebView user agent *before* Laya
 * reads it, so Laya computes `onMobile = true` / `onPC = false` by itself -
 * no property is forced, and nothing fights the shim. That one difference is
 * the whole black screen:
 *
 *   `FileUtils.createDirectoryForce` and `FileUtils.saveFile` branch on
 *   `Browser.onPC` with no `else`, and the `SyncTask.taskOver(
 *   FileUtils.TASK_MODIFY_FILE)` that releases the file-task lock lives inside
 *   the callback the mobile path drops. The loading bundle still finishes - its
 *   loader is independent - the transition curtain is painted, and the default
 *   save write, the fourth-wall gags and the first scene's BGM stay queued
 *   behind a lock that is never released.
 *
 * Without this flag the run reaches all six post-load landmarks; with it, all
 * five engine-owned ones disappear and the request stream matches the phone's
 * byte for byte. It is the regression harness for that fix, so it needs no
 * device round trip to re-verify.
 */
const UA_MOBILE = argv.includes('--ua-mobile');
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; PJE110 Build/UKQ1.230804.001; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.4 Mobile Safari/537.36';

/**
 * Installed as its own init script, *before* the page's own scripts run, so the
 * `__GCNative` assignment made by inpage-host.js is intercepted as it happens.
 * `gc-bridge.js` looks each host method up dynamically, so wrapping the
 * properties keeps the shim's behaviour identical for the run itself.
 */
const HOST_STACK_SRC = `(function () {
  window.__gcHostStack = [];
  var _host = null;
  Object.defineProperty(window, '__GCNative', {
    configurable: true,
    get: function () { return _host; },
    set: function (v) {
      try {
        if (v && typeof v === 'object') {
          var names = [];
          for (var k in v) { try { if (typeof v[k] === 'function') names.push(k); } catch (e) {} }
          window.__gcHostStack.push('INIT keys=' + Object.keys(v).length + ' fns=' + names.length);
          for (var i = 0; i < names.length; i++) {
            (function (n) {
              var orig = v[n];
              v[n] = function () {
                try {
                  var st = String((new Error()).stack || '').split('\\n').slice(1, 14).join(' | ');
                  window.__gcHostStack.push(n + ' :: ' + st);
                } catch (e) {}
                return orig.apply(v, arguments);
              };
            })(names[i]);
          }
        }
      } catch (e) { window.__gcHostStack.push('INIT wrap-failed ' + e); }
      _host = v;
    }
  });
}());`;

const LOG = path.join(
  OUT_DIR,
  'transition-probe' + (NO_WEBGL ? '-2d' : '') +
  (BTN_MODE !== 'disk' ? '-btn-' + BTN_MODE : '') +
  (WORKER_MODE !== 'real' ? '-wk-' + WORKER_MODE : '') +
  (PATCH_OBJUTILS ? '-patch' : '') + '.log'
);

/**
 * A real 1x1 PNG. The engine's own resource protection rewrites bytes 1..2 of
 * every image it loads (`89 50 4E 47` arrives as `89 4E 50 47`), so an asset
 * served to it must be pre-swapped or it decrypts into garbage.
 */
const PNG_1X1_NORMAL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
function protectedPng() {
  const b = Buffer.from(PNG_1X1_NORMAL);
  const t = b[1]; b[1] = b[2]; b[2] = t; // exactly what the engine undoes
  return b;
}
const VIEWPORT = (function () {
  const m = /^(\d+)x(\d+)$/.exec(process.env.LOVENEST_VIEWPORT || '1600x900');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1600, height: 900 };
})();
const EXTRA_ARGS = (process.env.LOVENEST_BROWSER_ARGS || '').split(' ').filter(Boolean);
const BROWSER_ARGS = [
  '--allow-file-access-from-files',
  '--autoplay-policy=no-user-gesture-required',
].concat(EXTRA_ARGS);

const INPAGE_HOST = path.join(__dirname, 'inpage-host.js');
const GC_BRIDGE = path.resolve(
  __dirname, '..', '..', 'android-app', 'app', 'src', 'main', 'assets', 'gc-bridge.js'
);

const lines = [];
const record = (s) => lines.push('[' + new Date().toISOString().slice(11, 23) + '] ' + s);

/** Filled in after we can stat the files; used by the control-XHR section. */
const CONTROL_RELS = [
  'asset/json/animation/data/ani1.json',
  'asset/json/animation/data/ani4002.json',
  'asset/json/startup.json',
  'asset/image/picture/control/hscroll_bar.png',
];

/**
 * Installed in the page before any page script. Records every `Worker`
 * construction, the URL kind, whether an `onmessage` handler was attached,
 * whether `postMessage` was called, and whether a reply ever came back - the
 * only way to observe a worker that is silently dead.
 *
 * `mode`:
 *   `real` - the genuine Worker, wrapped for observation.
 *   `dead` - constructs cleanly, never replies (the suspected Android shape).
 *   `none` - `window.Worker = undefined`, forcing the engine's synchronous
 *            `JSON.parse(JSON.stringify(o))` branch.
 *
 * Injected via `Function.prototype.toString`, so this is ordinary readable
 * JavaScript rather than a quoted string.
 */
function workerSnippet(mode) {
  var log = [];
  window.__gcWorkerLog = log;
  function kindOf(url) {
    var s = String(url);
    if (/^blob:/.test(s)) return 'blob';
    if (/^file:/.test(s)) return 'file';
    return 'other';
  }
  var Real = window.Worker;
  if (typeof Real !== 'function') {
    log.push({ ev: 'no-Worker-global' });
    return;
  }
  if (mode === 'dead') {
    function Goblin(url) {
      var self = this;
      log.push({ ev: 'construct', kind: kindOf(url), mode: 'dead' });
      this.postMessage = function (msg) {
        log.push({ ev: 'postMessage', key: msg && msg.key, type: msg && msg.type,
          hasOnMessage: typeof self.onmessage === 'function' });
        return null;
      };
      this.addEventListener = function () { return null; };
      this.terminate = function () { log.push({ ev: 'terminate' }); };
    }
    window.Worker = Goblin;
    return;
  }
  if (mode === 'none') {
    window.Worker = undefined;
    log.push({ ev: 'Worker-disabled' });
    return;
  }

  // Observation, done by patching the *prototype* and shadowing `onmessage` on
  // the instance. A Proxy over a host object like Worker is where the earlier
  // `Illegal invocation` came from; none of that is needed here.
  var proto = Real.prototype;
  var origPost = proto.postMessage;
  proto.postMessage = function (msg) {
    log.push({ ev: 'postMessage', key: msg && msg.key, type: msg && msg.type });
    var self = this;
    try {
      if (mode === 'throwclone') {
        // Reproduce `DataCloneError` exactly as a structured clone failure
        // surfaces: a throw from postMessage, which the engine swallows.
        var e = new Error('DataCloneError: simulated (mode=throwclone)');
        e.name = 'DataCloneError';
        throw e;
      }
      return origPost.call(this, msg);
    } finally {
      void self;
    }
  };
  var desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
  function Spied(url, opts) {
    log.push({ ev: 'construct', kind: kindOf(url) });
    var w = new Real(url, opts);
    if (desc && desc.set && desc.get) {
      try {
        Object.defineProperty(w, 'onmessage', {
          configurable: true,
          get: function () { return desc.get.call(this); },
          set: function (fn) {
            log.push({ ev: 'set-onmessage' });
            desc.set.call(this, function (ev) {
              var d = ev && ev.data;
              log.push({ ev: 'reply', key: d && d.key, gcJsonUtils: !!(d && d.gcJsonUtils) });
              return fn.apply(this, arguments);
            });
          },
        });
      } catch (e) {
        log.push({ ev: 'observer-failed', err: String(e) });
      }
    }
    return w;
  }
  Spied.prototype = proto;
  window.Worker = Spied;
}

/**
 * Installed in the page before any page script, once `window.ObjectUtils`
 * exists. Replaces the two worker-mediated helpers with worker-free versions
 * that keep each branch's exact contract.
 *
 * Why. `ObjectUtils.workJsonHandler` posts to a lazily built blob worker whose
 * only handler is `onmessage` - there is no `onerror`. It stores the
 * continuation in `_workerOnFins[key]` *before* posting and, if `postMessage`
 * throws, only logs. So a worker that never replies, or a payload structured
 * clone rejects, loses the continuation silently: no throw, no XHR, no host
 * call, and the engine's loop keeps running over a black cover. The worker's
 * entire job is JSON, so there is nothing to gain from a worker here, and
 * `JSON.stringify` (the engine's own fallback) cannot fail the way structured
 * clone can.
 *
 * The four worker operations, reproduced exactly:
 *   type 1 -> JSON.stringify({mode:0, localURL, content: isJson ? stringify(dataObject) : dataObject})
 *   type 3 -> JSON.stringify(dataObject)            (jsonSerialize2)
 *   type 4 -> JSON.stringify({mode:8, localURL, content: dataObject})
 *   depthClone -> JSON.parse(JSON.stringify(o))
 *
 * Contracts preserved:
 *   depthClone(o, true,  cb) -> cb(clone) asynchronously, returns null
 *   depthClone(o, false, cb) -> cb(null) inline, returns clone
 *   jsonSerialize(..., useworker=true)  -> onFin(str) asynchronously
 *   jsonSerialize(..., useworker=false) -> onFin(str) inline
 */
function objectUtilsPatch() {
  function apply(O) {
    if (!O || O.__gcWorkerFree === true) return false;
    try { O.__gcWorkerFree = true; } catch (e) { return false; }

    function cloneSync(o) {
      if (o === undefined) return undefined;
      try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; }
    }
    function later(fn, value) {
      setTimeout(function () { try { fn(value); } catch (e) {} }, 0);
    }

    O.depthClone = function (o, useworker, onFin) {
      if (useworker === void 0) useworker = false;
      if (onFin === void 0) onFin = null;
      if (o == null) {
        if (onFin) onFin(null);
        return null;
      }
      var clone = cloneSync(o);
      if (useworker) {
        if (onFin) later(onFin, clone);
        return null;
      }
      if (onFin) onFin(null);
      return clone;
    };

    O.jsonSerialize = function (o, onFin, type, useworker) {
      if (onFin === void 0) onFin = null;
      if (useworker === void 0) useworker = false;
      var p = o || {};
      var result;
      try {
        if (useworker && type == 1) {
          var s = p.isJson
            ? (p.format ? JSON.stringify(p.dataObject, null, 4) : JSON.stringify(p.dataObject))
            : p.dataObject;
          result = JSON.stringify({ mode: 0, localURL: p.localURL, content: s });
        } else if (useworker && type == 4) {
          result = JSON.stringify({ mode: 8, localURL: p.localURL, content: p.dataObject });
        } else {
          result = JSON.stringify(p.dataObject, null, p.format ? 4 : null);
        }
      } catch (e) {
        result = null;
      }
      if (useworker) {
        if (onFin) later(onFin, result);
        return;
      }
      if (onFin) onFin(result);
    };
    return true;
  }

  window.__gcObjUtilsPatched = false;
  function attempt() {
    if (apply(window.ObjectUtils)) {
      window.__gcObjUtilsPatched = true;
      if (window.__gcWorkerLog) window.__gcWorkerLog.push({ ev: 'objectUtils-patched' });
      return true;
    }
    return window.__gcObjUtilsPatched === true;
  }
  // Poll as fast as the timer allows: `ObjectUtils` is defined during script
  // evaluation, while its first use needs a completed XHR, so this always wins.
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (attempt() || tries > 4000) clearInterval(iv);
  }, 1);
  attempt();
  window.__gcPatchTries = function () { return tries; };
}

/**
 * `window.__gcDiag` must be true before `installDiagnostics()` runs, so it is
 * set ahead of the bridge text. The harness heartbeat mirrors drive.js.
 */
function buildInitScript(control) {
  const config = JSON.stringify({ gameRoot: GAME_ROOT, docsRoot: DOCS_ROOT });
  const host = fs.readFileSync(INPAGE_HOST, 'utf8');
  const bridge = fs.readFileSync(GC_BRIDGE, 'utf8');
  // Must run before `script.js`: Laya asks for a context during init, and the
  // decision is read-only after that.
  const noWebgl =
    '\n;(function () {\n' +
    '  var orig = HTMLCanvasElement.prototype.getContext;\n' +
    '  HTMLCanvasElement.prototype.getContext = function (type) {\n' +
    '    if (/webgl/i.test(String(type))) return null;\n' +
    '    return orig.apply(this, arguments);\n' +
    '  };\n' +
    '}());\n';

  const workerPatch =
    '\n;(' + workerSnippet.toString() + ')(' + JSON.stringify(WORKER_MODE) + ');\n';

  const objUtilsPatch = PATCH_OBJUTILS
    ? '\n;(' + objectUtilsPatch.toString() + ')();\n'
    : '';

  const uaMobile = UA_MOBILE
    ? '\n;(function () {\n' +
      '  var ua = ' + JSON.stringify(ANDROID_UA) + ';\n' +
      '  try {\n' +
      '    Object.defineProperty(navigator, "userAgent", { configurable: true, get: function () { return ua; } });\n' +
      '    Object.defineProperty(navigator, "appVersion", { configurable: true, get: function () { return ua; } });\n' +
      '  } catch (e) {}\n' +
      '}());\n'
    : '';

  return (
    'window.__gcDiag = true;\n' +
    'window.__GCNativeConfig = ' + config + ';\n' +
    'window.__gcControls = ' + JSON.stringify(control) + ';\n' +
    uaMobile +
    (NO_WEBGL ? noWebgl : '') +
    host + '\n;\n' +
    bridge + '\n' +
    workerPatch +
    objUtilsPatch +
    ';(function () {\n' +
    '  window.__gcHeartbeat = 0;\n' +
    '  setInterval(function () { window.__gcHeartbeat++; }, 250);\n' +
    '}());\n'
  );
}

/**
 * Runs in the page. Reads the engine's own state defensively: every field is
 * behind its own try/catch, because this runs against a minified 1.7.17beta
 * build whose internals are guesses, and a throw here would destroy the one
 * measurement we cannot get any other way.
 */
function dumpEngine() {
  function safe(fn, fallback) {
    try {
      var v = fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      return '<throw:' + e.name + '>';
    }
  }
  function className(o) {
    return safe(function () {
      if (!o) return String(o);
      var c = o.constructor;
      if (c && c.name) return c.name;
      if (o._$P) return String(o._$P);
      return Object.prototype.toString.call(o);
    }, '?');
  }
  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : v;
  }
  function describe(o, depth, budget) {
    if (!o || depth > 4 || budget.n <= 0) return null;
    budget.n--;
    var d = {
      cls: className(o),
      name: safe(function () { return o.name || null; }, null),
      alpha: safe(function () { return num(o.alpha); }),
      visible: safe(function () { return o.visible; }),
      x: safe(function () { return num(o.x); }),
      y: safe(function () { return num(o.y); }),
      w: safe(function () { return num(o.width); }),
      h: safe(function () { return num(o.height); }),
      kids: safe(function () { return o.numChildren; }),
      hasTex: safe(function () { return !!(o.texture || o._texture); }, null),
      hasGfx: safe(function () { return !!o.graphics; }, null)
    };
    // The minified build keeps its child list under a name we do not know, so
    // prefer the public `getChildAt` and only fall back to the underscored
    // fields for reference.
    var kids = safe(function () {
      var n = o.numChildren;
      if (typeof n !== 'number' || n <= 0) return null;
      if (typeof o.getChildAt !== 'function') return null;
      var arr = [];
      for (var i = 0; i < n; i++) {
        var c = o.getChildAt(i);
        if (c) arr.push(c);
      }
      return arr.length ? arr : null;
    }, null);
    d.childArrayName = safe(function () {
      if (o._children && o._children.length) return '_children';
      if (o._childs && o._childs.length) return '_childs';
      return null;
    }, null);
    if (kids) {
      d.children = [];
      for (var i = 0; i < kids.length; i++) {
        var c = describe(kids[i], depth + 1, budget);
        if (c) d.children.push(c);
      }
    }
    return d;
  }

  var out = { at: Date.now() - (window.__gcT0 || 0), heartbeat: window.__gcHeartbeat };
  var Laya = safe(function () { return window.Laya; }, null);
  out.hasLaya = !!Laya;
  if (!Laya) return out;

  out.browser = safe(function () {
    return {
      width: Laya.Browser.width,
      height: Laya.Browser.height,
      pixelRatio: Laya.Browser.pixelRatio,
      canvas: Laya.Browser.canvas ? { w: Laya.Browser.canvas.width, h: Laya.Browser.canvas.height } : null
    };
  });

  out.timer = safe(function () {
    return {
      delta: num(Laya.timer.delta),
      currFrame: Laya.timer.currFrame,
      scale: Laya.timer.scale,
      currTimer: Laya.timer.currTimer
    };
  });

  out.stage = safe(function () {
    var s = Laya.stage;
    return {
      cls: className(s),
      kids: s.numChildren,
      width: num(s.width),
      height: num(s.height),
      scaleMode: s.scaleMode,
      alignH: s.alignH,
      alignV: s.alignV,
      bgColor: s.bgColor,
      visible: s.visible
    };
  });

  out.stageTree = safe(function () {
    var s = Laya.stage;
    var budget = { n: 160 };
    var n = s.numChildren || 0;
    var arr = [];
    for (var i = 0; i < n; i++) {
      var c = s.getChildAt(i);
      var d = describe(c, 0, budget);
      if (d) arr.push(d);
    }
    return arr;
  });

  out.domCanvases = safe(function () {
    var list = document.querySelectorAll('canvas');
    var arr = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      arr.push({
        w: c.width, h: c.height,
        cssW: c.style && c.style.width, cssH: c.style && c.style.height,
        cls: c.className || null,
        parent: c.parentNode ? (c.parentNode.id || c.parentNode.tagName) : null
      });
    }
    return arr;
  });

  out.objUtils = safe(function () {
    var O = window.ObjectUtils;
    if (!O) return 'absent';
    var pend = null;
    try {
      pend = O._workerOnFins ? Object.keys(O._workerOnFins).length : null;
    } catch (e) { pend = '<throw>'; }
    return {
      hasWorker: !!O._worker,
      pendingContinuations: pend,
      idCount: O.idCount,
      workerFree: O.__gcWorkerFree === true,
      patchedAt: window.__gcObjUtilsPatched === true,
      depthCloneSource: String(O.depthClone).slice(0, 120)
    };
  });

  out.workers = safe(function () {
    var l = window.__gcWorkerLog;
    if (!l) return null;
    return { n: l.length, tail: JSON.stringify(l.slice(-8)) };
  });

  out.render = safe(function () {
    var R = Laya.Render;
    if (!R) return null;
    return {
      isWebGL: R.isWebGL,
      is3D: R.is3D,
      engine: R.engine,
      canvas: R.canvas ? { w: R.canvas.width, h: R.canvas.height } : null
    };
  });

  out.os = safe(function () {
    var o = window.os;
    if (!o) return null;
    var rec = {};
    var keys = ['platform', 'isAndroid', 'isIOS', 'isPC', 'canvasWidth', 'canvasHeight',
      'scaleX', 'scaleY', 'pixelRatio', 'window'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      rec[k] = safe(function () { var v = o[k]; return (typeof v === 'object' && v) ? '<obj>' : v; });
    }
    return rec;
  });

  out.loader = safe(function () {
    var l = Laya.loader;
    if (!l) return null;
    var loaded = null;
    try {
      var map = l.loadedMap || l._loadedMap;
      loaded = map ? Object.keys(map).length : null;
    } catch (e) { loaded = '<throw>'; }
    return {
      loadedCount: loaded,
      maxTimeOut: safe(function () { return l.maxTimeOut; }, null),
      hasClearRes: safe(function () { return typeof l.clearRes; }, null)
    };
  });

  return out;
}

/**
 * Runs in the page. Fires the control requests with a bare XHR and *no*
 * wrapper, and reports what the transport actually handed back, in bytes
 * measured three independent ways.
 */
function runControls() {
  // `__gcControls` is a `{rel: onDiskBytes}` object, so enumerate its keys.
  var wanted = window.__gcControls || {};
  var rels = Object.keys(wanted);
  var jobs = rels.map(function (rel) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      var t0 = Date.now();
      function finish(how) {
        var rec = { rel: rel, how: how, ms: Date.now() - t0 };
        try { rec.status = xhr.status; } catch (e) { rec.status = 'throw'; }
        try { rec.readyState = xhr.readyState; } catch (e) { rec.readyState = 'throw'; }
        try { rec.responseType = xhr.responseType; } catch (e) { rec.responseType = 'throw'; }
        try {
          var t = xhr.responseText;
          rec.textLen = (t == null) ? null : t.length;
          // Independent byte count: UTF-8 bytes of the text we received.
          rec.textUtf8 = (t == null) ? null : new TextEncoder().encode(t).length;
        } catch (e) { rec.textLen = 'throw:' + e.name; }
        resolve(rec);
      }
      xhr.addEventListener('load', function () { finish('load'); });
      xhr.addEventListener('error', function () { finish('error'); });
      xhr.addEventListener('abort', function () { finish('abort'); });
      xhr.addEventListener('timeout', function () { finish('timeout'); });
      try {
        xhr.open('GET', rel);
        xhr.send();
      } catch (e) { finish('throw:' + e.name); }
    });
  });
  return Promise.all(jobs);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const control = {};
  for (const rel of CONTROL_RELS) {
    const abs = path.join(GAME_ROOT, rel);
    if (fs.existsSync(abs)) control[rel] = fs.statSync(abs).size;
  }

  const indexUrl = pathToFileURL(path.join(GAME_ROOT, 'index.html')).href;
  record('# game root: ' + GAME_ROOT);
  record('# inject diag: true, total: ' + TOTAL_MS + 'ms');
  record('# no-webgl (force Canvas 2D renderer): ' + NO_WEBGL);
  record('# btn-mode: ' + BTN_MODE);
  record('# worker-mode: ' + WORKER_MODE);
  record('# patch-objectutils: ' + PATCH_OBJUTILS);
  record('# extra browser args: ' + JSON.stringify(EXTRA_ARGS));
  record('# control files (on-disk bytes): ' + JSON.stringify(control));

  const browser = await chromium.launch({ args: BROWSER_ARGS });
  let pageErrors = [];
  let workerLogFinal = null;
  let hostStackFinal = [];

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    page.on('console', (msg) => {
      const text = msg.text();
      // The shim's own diag lines arrive as `[host:log] ...`; keep them
      // verbatim so they can be diffed against the phone's session log.
      record('[console.' + msg.type() + '] ' + text);
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err && err.stack ? err.stack : String(err));
      record('[pageerror] ' + (err && err.stack ? err.stack : String(err)));
    });
    page.on('requestfailed', (req) => {
      const f = req.failure();
      record('[requestfailed] ' + req.url() + ' :: ' + (f ? f.errorText : 'unknown'));
    });

    await page.route(
      (url) => url.pathname.endsWith('/script.js'),
      async (route) => {
        const body = fs.readFileSync(path.join(GAME_ROOT, 'script.js'), 'utf8');
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
          body,
        });
      }
    );

    if (BTN_MODE !== 'disk') {
      const btnMask = /\/control\/btn_(over|click|normal)\.png$/;
      await page.route(
        (url) => btnMask.test(url.pathname),
        async (route) => {
          if (BTN_MODE === 'empty') {
            // The phone's answer: a completed request, zero bytes, no error.
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'image/png' },
              body: Buffer.alloc(0),
            });
          } else if (BTN_MODE === 'hang') {
            // Never answer at all. This is the one state Playwright can produce
            // that the engine cannot distinguish from "still loading": no
            // `load`, no `error`, no `abort`. If the engine waits on a loader
            // item, this reproduces the phone's stall exactly.
            return;
          } else {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'image/png' },
              body: protectedPng(),
            });
          }
        }
      );
    }
    if (HOST_STACK) await page.addInitScript(HOST_STACK_SRC);
    await page.addInitScript(buildInitScript(control));

    const t0 = Date.now();
    await page.goto(indexUrl, { waitUntil: 'load', timeout: 120000 });
    record('# window load at +' + (Date.now() - t0) + 'ms');
    await page.evaluate(() => { window.__gcT0 = Date.now(); });

    // Let the title settle, then reproduce the phone's flow: tap, tap.
    await page.waitForTimeout(8000);
    record('# --- engine state on the title screen (+' + (Date.now() - t0) + 'ms) ---');
    record(JSON.stringify(await page.evaluate(dumpEngine)));
    if (PLATFORM_PROBE) {
      record('# platform probe: ' + JSON.stringify(await page.evaluate(() => {
        const out = { hasLaya: typeof Laya, navUA: navigator.userAgent.slice(0, 100) };
        try {
          const B = Laya && Laya.Browser;
          out.hasLayaBrowser = typeof B;
          if (B) {
            out.onPC = B.onPC;
            out.onMobile = B.onMobile;
            out.onAndriod = B.onAndriod;
            out.u = String(B.u).slice(0, 100);
            out.pixelRatio = B.pixelRatio;
          }
        } catch (e) { out.err = String(e); }
        try { out.layaKeys = Object.keys(Laya).length; } catch (e) { out.err2 = String(e); }
        return out;
      })));
    }
    await page.screenshot({ path: path.join(OUT_DIR, 'transition-01-title.png') });

    record('# clicking canvas centre (reproducing the phone flow)');
    await page.mouse.click(Math.round(VIEWPORT.width / 2), Math.round(VIEWPORT.height / 2));
    await page.waitForTimeout(1500);
    await page.mouse.click(Math.round(VIEWPORT.width / 2), Math.round(VIEWPORT.height / 2));

    let tick = 0;
    while (Date.now() - t0 < TOTAL_MS) {
      await page.waitForTimeout(3000);
      tick++;
      const at = Date.now() - t0;
      record('# --- engine state +' + at + 'ms (tick ' + tick + ') ---');
      try {
        record(JSON.stringify(await page.evaluate(dumpEngine)));
      } catch (err) {
        record('# DUMP FAILED: ' + String(err));
        break;
      }
      if (tick % 3 === 0) {
        await page.screenshot({
          path: path.join(OUT_DIR, 'transition-tick-' + String(tick).padStart(2, '0') + '.png'),
        }).catch(() => {});
      }
    }

    record('# --- control XHRs (same page, same origin, same moment) ---');
    try {
      workerLogFinal = await page.evaluate(() => (window.__gcWorkerLog || []));
    } catch (err) {
      record('# worker log read failed: ' + String(err));
    }
    try {
      const results = await page.evaluate(runControls);
      for (const r of results) {
        const want = control[r.rel];
        const got = (typeof r.textUtf8 === 'number') ? r.textUtf8 : null;
        record('  ' + (got === want ? 'MATCHES DISK' : 'DIFFERS') +
          '  ' + r.rel + '  how=' + r.how + ' status=' + r.status +
          ' rs=' + r.readyState + ' textLen=' + r.textLen +
          ' textUtf8=' + r.textUtf8 + ' want=' + want + ' ms=' + r.ms);
      }
    } catch (err) {
      record('# control XHRs failed: ' + String(err));
    }

    await page.screenshot({ path: path.join(OUT_DIR, 'transition-99-final.png') }).catch(() => {});

    if (HOST_STACK) {
      try {
        const diag = await page.evaluate(() => ({
          t: typeof window.__gcHostStack,
          n: (window.__gcHostStack || []).length,
          nat: typeof window.__GCNative,
        }));
        record('# host stack diag: ' + JSON.stringify(diag));
        hostStackFinal = await page.evaluate(() => window.__gcHostStack || []);
      } catch (err) {
        record('# host stack read failed: ' + String(err));
      }
    }
  } catch (err) {
    record('[fatal] ' + (err && err.stack ? err.stack : String(err)));
  } finally {
    await browser.close();
  }

  // What matters is how far the engine's *logic* got, which is independent of
  // whether anything painted. These are the landmarks the working run reaches,
  // in order, after the loading screen.
  const seen = lines
    .filter((l) => l.indexOf('REQ start') !== -1)
    .map((l) => {
      const m = /url=(\S+)/.exec(l);
      return m ? decodeURIComponent(m[1]).replace(/^.*DemoV1\.52\//, '') : '?';
    });
  const landmarks = [
    ['前面板 (Pray_1.ogg)', 'asset/audio/se/environment/Pray_1.ogg'],
    ['Meta gag: 桌面壁纸 reg query', 'reg query'],
    ['Meta gag: AppData', 'AppData'],
    ['Meta gag: 攻略.txt', '游戏攻略.txt'],
    ['BGM 握起残肢跳舞吧.mp3', '握起残肢跳舞吧.mp3'],
    ['对话框 UI backgroundcolor', 'dialog/backgroundcolor_1.png'],
  ];
  const hay = lines.join('\n');
  record('# total REQ start = ' + seen.length);
  record('# last 6 requests: ' + JSON.stringify(seen.slice(-6)));
  for (const [label, needle] of landmarks) {
    record('# landmark ' + label + ' = ' + (hay.indexOf(needle) !== -1));
  }
  record('# btn requests seen = ' + seen.filter((u) => /\/control\/btn_/.test(u)).length);
  try {
    const wlog = workerLogFinal || [];
    record('# worker log (' + wlog.length + ' events) = ' + JSON.stringify(wlog.slice(0, 24)));
  } catch (err) {
    record('# worker log unavailable: ' + String(err));
  }
  if (HOST_STACK) {
    record('# host call stacks (' + hostStackFinal.length + ') -> out/host-stacks.txt');
    fs.writeFileSync(
      path.join(OUT_DIR, 'host-stacks.txt'),
      hostStackFinal.join('\n') + '\n',
      'utf8'
    );
  }
  record('# pageerrors: ' + pageErrors.length);
  fs.writeFileSync(LOG, lines.join('\n') + '\n');
  console.log('transition log -> ' + LOG);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error('transition-probe.js: unexpected failure', err);
    process.exitCode = 1;
  }
);
