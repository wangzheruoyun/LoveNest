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
 * Usage: node tools/headless/run.js
 * Env:   LOVENEST_GAME_ROOT  override the game folder
 *        LOVENEST_WAIT_MS    override the settle time (default 20000)
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

// Browser flags that mirror the Android WebSettings chosen in the design doc
// §5.3, so the headless run is behaviourally comparable to the device:
//   setAllowFileAccessFromFileURLs(true) / setAllowUniversalAccessFromFileURLs(true)
//     -> '--allow-file-access-from-files'
//        The engine reads local JSON (asset/json/startup.json) over XHR from a
//        file:// origin, which Chromium blocks with a CORS error by default.
//   setMediaPlaybackRequiresUserGesture(false)
//     -> '--autoplay-policy=no-user-gesture-required'
//        The engine creates an AudioContext before any user gesture.
const BROWSER_ARGS = [
  '--allow-file-access-from-files',
  '--autoplay-policy=no-user-gesture-required',
];

function stamp() {
  return new Date().toISOString();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const lines = [];
  const pageErrors = [];
  const record = (s) => lines.push(s);

  const indexPath = path.join(GAME_ROOT, 'index.html');
  const indexUrl = pathToFileURL(indexPath).href;

  record('# game root: ' + GAME_ROOT);
  record('# url: ' + indexUrl);
  record('# started: ' + stamp());
  record('# wait: ' + WAIT_MS + 'ms');

  if (!fs.existsSync(indexPath)) {
    record('[fatal] index.html not found at ' + indexPath);
    fs.writeFileSync(CONSOLE_LOG, lines.join('\n') + '\n');
    console.error('run.js: index.html not found at ' + indexPath);
    return 1;
  }

  const browser = await chromium.launch({ args: BROWSER_ARGS });

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    page.on('console', (msg) => {
      record('[console.' + msg.type() + '] ' + msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err);
      record('[pageerror] ' + (err && err.stack ? err.stack : String(err)));
    });
    page.on('requestfailed', (req) => {
      const failure = req.failure();
      record('[requestfailed] ' + req.url() + ' :: ' + (failure ? failure.errorText : 'unknown'));
    });

    await page.goto(indexUrl, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(WAIT_MS);

    await page.screenshot({ path: SCREENSHOT });
    record('# screenshot: ' + SCREENSHOT);
  } catch (err) {
    record('[fatal] ' + (err && err.stack ? err.stack : String(err)));
    pageErrors.push(err);
  } finally {
    await browser.close();
  }

  record('# finished: ' + stamp());
  record('# page errors: ' + pageErrors.length);
  fs.writeFileSync(CONSOLE_LOG, lines.join('\n') + '\n');

  console.log('screenshot -> ' + SCREENSHOT);
  console.log('console    -> ' + CONSOLE_LOG);
  console.log('pageerrors = ' + pageErrors.length);

  return pageErrors.length === 0 ? 0 : 1;
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
