# Headless harness notes

Everything below is **measured on this machine**, not inferred.

## Environment

| | |
|---|---|
| Distro | Debian GNU/Linux 13 (trixie), aarch64, `PRoot-Distro` kernel |
| Node | v26.12.0 (npm 11.20.0) |
| Playwright | 1.64.1 |
| Browser | Chrome for Testing 156.0.8078.4 (`chromium-1248` + `chromium_headless_shell-1248`), `linux-arm64` |
| Verdict | **Playwright + Chromium works here.** No fallback was needed. |

## Two network workarounds were required

The network on this machine is flaky for large responses, which cost several attempts.
Both are install-time only and are not baked into any committed file.

1. **npm registry.** `npm i -D playwright` against `registry.npmjs.org` fails with
   `ECONNRESET` / `Invalid response body … aborted`. The `playwright` packument is
   ~8 MB (`Accept: application/vnd.npm.install-v1+json` → 8167609 bytes) and the
   connection is dropped part-way. Installing from `https://registry.npmmirror.com`
   succeeded in 10 s.
   ```
   npm i -D playwright --registry=https://registry.npmmirror.com
   ```
2. **Browser binaries.** `npx playwright install chromium` fails downloading from
   `cdn.playwright.dev` (`Download failed: server closed connection`, 190.5 MiB
   `linux-arm64` build). Downloading from the npmmirror mirror succeeded:
   ```
   PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium
   ```

3. **Missing system libraries.** The first launch died with
   `error while loading shared libraries: libglib-2.0.so.0`. The Termux libs under
   `/data/data/com.termux/files/usr/lib` are bionic and unusable by the proot Debian
   glibc environment, so the Debian packages were installed instead:
   ```
   npx playwright install-deps chromium      # apt-get; also pulls xvfb + fonts-wqy-zenhei
   ```
   After this, `chromium.launch()` succeeds and screenshots render.
   Sanity probe: `TITLE: ok` / `VERSION: 156.0.8078.4` / `LAUNCH_OK`.

## Browser flags in `run.js` (why they exist)

`run.js` launches Chromium with two flags that mirror the Android `WebSettings`
chosen in the design doc §5.3, so the headless run is behaviourally comparable to
the device:

| Flag | Android equivalent |
|---|---|
| `--allow-file-access-from-files` | `setAllowFileAccessFromFileURLs(true)` / `setAllowUniversalAccessFromFileURLs(true)` |
| `--autoplay-policy=no-user-gesture-required` | `setMediaPlaybackRequiresUserGesture(false)` |

The first one matters a lot: without it the engine cannot read its own data (see
baseline A below). On Android these are the same settings spec §5.3 deliberately
enables, so enabling the equivalent here is parity, not a workaround.

## Baseline A — no shim, no file-access flag

Captured by removing both `BROWSER_ARGS` entries. Exit code 1, `pageerrors = 1`,
screenshot is fully black.

```
[pageerror] TypeError: topRequire is not a function
    at <anonymous>:2:12
    at eval (eval at <anonymous> (eval at <anonymous> (file:///…/script.js?r=1736932678789:2:8443309)), <anonymous>:1:3)
[console.warning] The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page.
[console.error] Access to XMLHttpRequest at 'file:///…/asset/json/startup.json' from origin 'null' has been blocked by CORS policy: Cross origin requests are only supported for protocol schemes: chrome, chrome-untrusted, data, http, https.
[requestfailed] file:///…/asset/json/startup.json :: net::ERR_FAILED
[console.warning] [.WebGL-0x…]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels
[console.warning] WebGL: CONTEXT_LOST_WEBGL: loseContext: context lost
[console.log]  %c OpenAPI v2.1 %c https://www.gamecreator.com.cn/plug/det/641  …
[console.log] 当前城市: Tiruvānmiyūr
# page errors: 1
```

The engine dies before it can even read its own data: `window.require` is not
defined, and `startup.json` is blocked. This is the expected pre-shim state.

## Baseline B — no shim, both flags on (the committed configuration)

Exit code 1, `pageerrors = 2`. Timings from this run: **~2 s from
`browser.launch()` to `load`** for the 9.5 MB `script.js` plus engine init,
i.e. ~22 s wall clock including the 20 s settle wait. Spec risk #5 (slow first
screen) does not materialise on this hardware. The screenshot is essentially
white with a broken-image glyph, as expected with no shim.

```
[pageerror] TypeError: topRequire is not a function
    at <anonymous>:2:12
[console.warning] [.WebGL-0x…]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels
[console.warning] WebGL: CONTEXT_LOST_WEBGL: loseContext: context lost
[console.log]  %c OpenAPI v2.1 %c https://www.gamecreator.com.cn/plug/det/641  …
[console.log] 当前城市: Tiruvānmiyūr
[console.log] shader error null          (×3)
[requestfailed] file:///…/asset/image/picture/control/btn_over.png :: net::ERR_FILE_NOT_FOUND
[requestfailed] file:///…/asset/image/picture/control/btn_click.png :: net::ERR_FILE_NOT_FOUND
[requestfailed] file:///…/asset/image/picture/control/btn_normal.png :: net::ERR_FILE_NOT_FOUND
[pageerror] TypeError: gcTop.require is not a function
    at new W26_WindowsFullName (<anonymous>:3:36)
    at W26_WindowsFullName.get (<anonymous>:35:40)
    at Object.f14 (<anonymous>:46:36)
    at cmd.paramsCompiled (eval at precompile_13 (:45092:9), <anonymous>:1:131)
    at Command.command_13 [as exeFunc] (<anonymous>:44961:31)
    at CommandPage.executeEvent (<anonymous>:45855:17)
    at CommandPage.startTriggerEvent (<anonymous>:45809:21)
    at SinglePlayerGame.startTriggerCommandV2 (<anonymous>:78155:39)
    at SinglePlayerGame.triggerEvent (<anonymous>:78051:30)
    at Callback.runWith (<anonymous>:469:35)
# page errors: 2
```

### What baseline B tells the later tasks

1. **`startup.json` now loads.** With `--allow-file-access-from-files` the engine
   gets past the CORS wall and runs its startup command list. The flag is a hard
   requirement, not a nicety.
2. **Both remaining `pageerror`s are the same root cause: no `window.require`.**
   - `topRequire is not a function` — the early platform probe (`os.platform`).
   - `gcTop.require is not a function` at `W26_WindowsFullName.get()` — the first
     **Meta演出** to execute. The engine read its own data successfully and then
     walked straight into the Windows-only "read the real user name" command,
     exactly as spec §2.3/§5.6 predicts.
   This is precisely the gap Tasks 2–4 (and the `child_process` mapping in Task 4)
   are meant to close, and it confirms `--inject` in Task 5 has a real target.
3. **`btn_normal.png` / `btn_over.png` / `btn_click.png` are genuinely absent from
   the game folder** (`find asset -iname 'btn_normal*'` returns nothing; the
   `asset/image/picture/control/` directory holds only scrollbar/checkbox/tab art).
   These `ERR_FILE_NOT_FOUND`s are a **pre-existing gap in the Demo build, not a
   harness defect**. Task 5 must not chase them and they must not be counted as
   harness regressions.
4. **WebGL is unstable in headless**: `GPU stall due to ReadPixels` then
   `CONTEXT_LOST_WEBGL`, plus three `shader error null` lines. The LayaAir renderer
   initialises but loses its context. This may be a headless/SwiftShader artefact
   rather than a real defect, but it means **"screenshot shows the title screen" is
   a weaker signal than "zero `pageerror`"** — worth remembering when Task 5 asks
   for visual confirmation of the title screen. If the context loss turns out to be
   environmental, the fix belongs in `run.js` launch args (`--use-gl=angle`,
   `--use-angle=swiftshader`, `--disable-gpu`, …), never in the shim.
5. **The engine reaches the network.** It printed `当前城市: Tiruvānmiyūr`
   (an IP-geolocation lookup) and a `gamecreator.com.cn` OpenAPI banner. Offline
   on a phone these simply fail; spec risk #6 anticipated this. Nothing to do now.

## Two behaviours later tasks must match

1. **`writeBase64()` creates missing parent directories** (`fs.mkdirSync(dirname,
   { recursive: true })`). The plan's Task 3 test writes to
   `<docsRoot>/save1.json` without creating `docsRoot` first, so the host has to
   do it. `GameBridge.writeBase64` in Task 7 must do the same, or the shim will
   work headless and fail on the device.
2. **Writes *under `gameRoot` are permitted* by design.** The host rejects only
   paths that escape `gameRoot`/`docsRoot` (plan Ruling 1 — one authority, one
   rule). Saves are expected to target `docsRoot` because the engine derives them
   from `os.homedir()`, but nothing here forbids a game-relative write. This is
   deliberate: adding a headless-only read-only rule would diverge from
   `GameBridge`. The protection for the 740 MB folder is test discipline, and the
   contract test above asserts the game tree is byte-identical after a
   representative workload.

## Fallback plan if a browser ever becomes unavailable

Not needed today, but recorded per the task brief. If Chromium cannot run, the
harness degrades to:

- `node --test tools/headless/host-native.test.js` — still fully valid, no browser
  involved (`createHost` is pure Node filesystem code).
- Tasks 2–4's `bridge.test.js` — also browser-free: the shim is loaded into a bare
  `node:vm` context, not into a page.
- The only capability lost is `run.js` end-to-end verification of the assembled
  shim against the real engine; that would fall back to on-device acceptance
  (plan Task 9) alone.

## Housekeeping

- The game folder `/storage/emulated/0/Download/爱之巢DemoV1.52/` is **read-only**
  for this repo. Verified after all runs: `find . -type f -newermt "2026-10-18 00:00"`
  returns nothing.
- Node tests here are **local-only and never run in CI** (plan Ruling 5): they need
  the 740 MB game folder, which is not uploaded anywhere.
- `tools/headless/out/` is scratch output and is git-ignored.
