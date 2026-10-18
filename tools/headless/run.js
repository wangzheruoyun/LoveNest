#!/usr/bin/env node
'use strict';

/**
 * Headless smoke run for the real game.
 *
 * Opens `<gameRoot>/index.html` over a `file://` URL in headless Chromium,
 * records everything the page logs (including uncaught `pageerror`s) for
 * `WAIT_MS`, then writes a screenshot and the console transcript.
 *
 * Exit code 0 means the page loaded and produced no `pageerror`.
 * Any `pageerror` means a non-zero exit.
 *
 * With `--inject` the run first installs the NW.js environment the engine
 * expects: `host-native.js`'s in-page twin (`inpage-host.js`) as
 * `window.__GCNative`, then `gc-bridge.js`, both through `page.addInitScript()`
 * so they run before any page script. `--inject` additionally *asserts* the
 * two properties a silently broken port would still render correctly without
 * (plan Rulings 2 and 3):
 *   - `os.platform === 2` — the branch that keeps every Meta performance and
 *     `fs` save alive.
 *   - `main()` ran exactly once — a white screen would otherwise be invisible.
 *
 * Usage: node tools/headless/run.js [--inject]
 * Env:   LOVENEST_GAME_ROOT  override the game folder
 *        LOVENEST_WAIT_MS    override the settle time (default 20000)
 *        LOVENEST_DOCS_ROOT  override the docs root (default /tmp/opencode/…)
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const GAME_ROOT =
  process.env.LOVENEST_GAME_ROOT || '/storage/emulated/0/Download/爱之巢DemoV1.52';
const WAIT_MS = Number(process.env.LOVENEST_WAIT_MS || 20000);
const OUT_DIR = path.join(__dirname, 'out');
const SCREENSHOT = path.join(OUT_DIR, 'screenshot.png');
const CONSOLE_LOG = path.join(OUT_DIR, 'console.log');
const VIEWPORT = { width: 1600, height: 900 };

// `--inject` turns on the shim. The in-page host and the shared bridge live
// next to this file / in the Android assets respectively; both are read as
// text and shipped into the page as one init script.
const INJECT = process.argv.slice(2).indexOf('--inject') !== -1;
const INPAGE_HOST = path.join(__dirname, 'inpage-host.js');
const GC_BRIDGE = path.resolve(
  __dirname, '..', '..', 'android-app', 'app', 'src', 'main', 'assets', 'gc-bridge.js'
);
// Saves are no-ops in-page (see inpage-host.js), so this root only affects
// which paths the engine *tries* to read. It must not be the game folder.
const DOCS_ROOT = process.env.LOVENEST_DOCS_ROOT || '/tmp/opencode/lovenest-docs';

// Browser flags that mirror the Android WebSettings chosen in the design doc
// §5.3, so the headless run is behaviourally comparable to the device:
//   setAllowFileAccessFromFileURLs(true) / setAllowUniversalAccessFromFileURLs(true)
//     -> '--allow-file-access-from-files'
//        The engine reads local JSON (asset/json/startup.json) over XHR from a
//        file:// origin, which Chromium blocks with a CORS error by default.
//        The in-page host needs the same permission for its synchronous XHR.
//   setMediaPlaybackRequiresUserGesture(false)
//     -> '--autoplay-policy=no-user-gesture-required'
//        The engine creates an AudioContext before any user gesture.
const BROWSER_ARGS = [
  '--allow-file-access-from-files',
  '--autoplay-policy=no-user-gesture-required',
];

// Appended to `script.js` so the run can prove `main()` was invoked exactly
// once (Ruling 3). `main` is a writable global function declaration, so a
// post-declaration reassignment survives; an earlier `defineProperty` trap
// would not.
const MAIN_COUNT_SNIPPET =
  '\n;window.__gcMainCalls = 0;\n' +
  '(function () {\n' +
  "  if (typeof main === 'function') {\n" +
  '    var __gcOriginalMain = main;\n' +
  '    main = function () {\n' +
  '      window.__gcMainCalls++;\n' +
  '      return __gcOriginalMain.apply(this, arguments);\n' +
  '    };\n' +
  '  }\n' +
  '})();\n';

/**
 * Page errors that come from the headless GPU stack rather than the port.
 * WebGL context loss and `shader error null` are documented environmental
 * artefacts (NOTES.md baseline B, plan carry-forward); they are counted and
 * reported separately, never as port regressions.
 */
function isEnvironmental(message) {
  return /CONTEXT_LOST_WEBGL|shader error|GPU stall/i.test(message);
}

function stamp() {
  return new Date().toISOString();
}

/** Config + in-page host + bridge, as one init script evaluated pre-page. */
function buildInitScript() {
  const config = JSON.stringify({ gameRoot: GAME_ROOT, docsRoot: DOCS_ROOT });
  const host = fs.readFileSync(INPAGE_HOST, 'utf8');
  const bridge = fs.readFileSync(GC_BRIDGE, 'utf8');
  return (
    'window.__GCNativeConfig = ' + config + ';\n' +
    host + '\n;\n' +
    bridge + '\n'
  );
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const lines = [];
  const pageErrorTexts = [];
  const record = (s) => lines.push(s);

  const indexPath = path.join(GAME_ROOT, 'index.html');
  const indexUrl = pathToFileURL(indexPath).href;

  record('# game root: ' + GAME_ROOT);
  record('# url: ' + indexUrl);
  record('# started: ' + stamp());
  record('# wait: ' + WAIT_MS + 'ms');
  record('# inject: ' + INJECT);

  if (!fs.existsSync(indexPath)) {
    record('[fatal] index.html not found at ' + indexPath);
    fs.writeFileSync(CONSOLE_LOG, lines.join('\n') + '\n');
    console.error('run.js: index.html not found at ' + indexPath);
    return 1;
  }

  const browser = await chromium.launch({ args: BROWSER_ARGS });

  let assertions = null;
  let loadMs = null;

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    page.on('console', (msg) => {
      record('[console.' + msg.type() + '] ' + msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrorTexts.push(err && err.stack ? err.stack : String(err));
      record('[pageerror] ' + (err && err.stack ? err.stack : String(err)));
    });
    page.on('requestfailed', (req) => {
      const failure = req.failure();
      record('[requestfailed] ' + req.url() + ' :: ' + (failure ? failure.errorText : 'unknown'));
    });

    if (INJECT) {
      // Serve `script.js` from disk with the main()-counter appended. The
      // engine loads it as `script.js?r=…`, so match on the pathname only.
      await page.route(
        (url) => url.pathname.endsWith('/script.js'),
        async (route) => {
          let body;
          try {
            body = fs.readFileSync(path.join(GAME_ROOT, 'script.js'), 'utf8') + MAIN_COUNT_SNIPPET;
          } catch (e) {
            record('[fatal] cannot read script.js for instrumentation: ' + e);
            return route.continue();
          }
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/javascript; charset=utf-8' },
            body,
          });
        }
      );
      await page.addInitScript(buildInitScript());
    }

    // `waitUntil: 'load'` resolves on the window `load` event, so this measures
    // first-screen time: navigation start → all sub-resources (including the
    // 9.5 MB `script.js`) loaded and `main()` about to run.
    const loadStart = Date.now();
    await page.goto(indexUrl, { waitUntil: 'load', timeout: 120000 });
    loadMs = Date.now() - loadStart;
    record('# load: ' + loadMs + 'ms (navigation start -> window load)');
    await page.waitForTimeout(WAIT_MS);

    if (INJECT) {
      assertions = await page.evaluate(() => {
        var platform = null;
        var source = null;
        // Prefer the engine's own `os.platform`. Falling back to
        // `Common.runPlatform` only when `os` is entirely absent keeps the
        // dangerous silent failure (os.platform === 3) visible: that getter
        // always returns 2 and would mask it.
        var osObj = (typeof window.os !== 'undefined') ? window.os : null;
        if (osObj && typeof osObj.platform !== 'undefined') {
          platform = osObj.platform;
          source = 'os.platform';
        } else if (typeof window.Common !== 'undefined' &&
          typeof window.Common.runPlatform !== 'undefined') {
          platform = window.Common.runPlatform;
          source = 'Common.runPlatform';
        }
        return {
          platform: platform,
          platformSource: source,
          mainCalls: (typeof window.__gcMainCalls === 'number') ? window.__gcMainCalls : null,
          hasCanvas: !!document.querySelector('canvas'),
          requireType: typeof window.require,
          bridge: !!window.__gcBridge,
        };
      });

      record('# assert platform: ' + assertions.platform + ' via ' + assertions.platformSource);
      record('# assert main calls: ' + assertions.mainCalls);
      record('# assert canvas: ' + assertions.hasCanvas);
      record('# assert window.require: ' + assertions.requireType + ', __gcBridge: ' + assertions.bridge);
    }

    await page.screenshot({ path: SCREENSHOT });
    record('# screenshot: ' + SCREENSHOT);
  } catch (err) {
    record('[fatal] ' + (err && err.stack ? err.stack : String(err)));
    pageErrorTexts.push(err && err.stack ? err.stack : String(err));
  } finally {
    await browser.close();
  }

  // Environmental GPU errors are counted separately and never fail the run;
  // they are a known headless artefact, not a harness or port regression.
  const engineErrorTexts = INJECT
    ? pageErrorTexts.filter((t) => !isEnvironmental(t))
    : pageErrorTexts;
  const environmentalCount = pageErrorTexts.length - engineErrorTexts.length;

  let assertionsOk = true;
  if (INJECT) {
    assertionsOk = !!assertions &&
      assertions.platform === 2 &&
      assertions.mainCalls === 1 &&
      assertions.hasCanvas === true;
    if (!assertionsOk) {
      record('[assert] FAILED — platform=' + (assertions && assertions.platform) +
        ' mainCalls=' + (assertions && assertions.mainCalls) +
        ' canvas=' + (assertions && assertions.hasCanvas));
    }
  }

  record('# finished: ' + stamp());
  record('# page errors: ' + engineErrorTexts.length);
  if (INJECT) record('# environmental page errors: ' + environmentalCount);
  fs.writeFileSync(CONSOLE_LOG, lines.join('\n') + '\n');

  console.log('screenshot -> ' + SCREENSHOT);
  console.log('console    -> ' + CONSOLE_LOG);
  if (INJECT) {
    console.log('platform   = ' + (assertions && assertions.platform) +
      ' (os.platform expected 2)');
    console.log('main calls = ' + (assertions && assertions.mainCalls) + ' (expected 1)');
    console.log('canvas     = ' + (assertions && assertions.hasCanvas));
    console.log('environmental pageerrors = ' + environmentalCount + ' (ignored)');
  }
  console.log('pageerrors = ' + engineErrorTexts.length);
  if (loadMs !== null) console.log('load       = ' + loadMs + 'ms');

  const ok = engineErrorTexts.length === 0 && assertionsOk;
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    // Set the code and let Node drain stdout; `process.exit()` can truncate a
    // piped stream, and the documented usage pipes this straight into `tail`.
    process.exitCode = code;
  },
  (err) => {
    console.error('run.js: unexpected failure', err);
    process.exitCode = 1;
  }
);
