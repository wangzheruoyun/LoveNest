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

## Task 5 — `run.js --inject` boots the real game (measured)

`node tools/headless/run.js --inject` → **exit 0**, `pageerrors = 0`,
`environmental page errors = 0`. Transcript: `out/console.log`.

| Assertion (plan Rulings 2 & 3) | Measured |
|---|---|
| `os.platform` | **2** (via `os.platform`, not the always-2 `Common.runPlatform` getter) |
| `main()` invocations | **1** |
| `<canvas>` in DOM | **true** |
| `typeof window.require` | `function` |
| `window.__gcBridge` | `true` |
| first-screen load | **~1.6 s** (1572 ms / 1637 ms across two runs; navigation start → `window load`) |

`run.js` now records `# load: <ms>` and prints `load = <ms>`; the number above is
the 9.5 MB `script.js` parse plus engine init. Spec risk #5 (slow first screen)
still does not materialise.

### How `--inject` works

`page.addInitScript()` (`buildInitScript()`), evaluated before any page script:

1. `window.__GCNativeConfig = { gameRoot, docsRoot }`.
2. `inpage-host.js` — the in-page twin of `host-native.js`, installing
   `window.__GCNative` with the same 19 methods. Reads (`exists`/`stat`/
   `readBase64`/`readDir`) use **synchronous `file://` XHR** with
   `overrideMimeType('text/plain; charset=x-user-defined')`; each byte is
   recovered via `charCodeAt(i) & 0xFF`. Bytes were verified identical to Node's
   `.toString('base64')`. Writes (`writeBase64`/`mkdirp`/`unlink`) are logged
   no-ops; Android-only capabilities log a line. No `http://` switch was needed —
   the page stays on `file://`, as the plan required.
3. `gc-bridge.js` unchanged in behaviour, extended with the globals the engine
   also touches.

`script.js` is served from disk through `page.route` (matched on
`url.pathname.endsWith('/script.js')`, since the engine loads it as
`script.js?r=…`) with `MAIN_COUNT_SNIPPET` appended. `main` is a writable global
function declaration, so the counter wrapper survives; a `defineProperty` trap
did not (hence the reassignment approach).

### Globals/modules the shim had to add in Task 5

Beyond Task 4's surface, the real engine also reached for: `fs.constants`
(`F_OK`, `R_OK`, `W_OK`, `X_OK`) and `fs.accessSync`/`access`; `fs.copyFileSync`,
`fs.renameSync`, `fs.rmdirSync`; `fs.createReadStream`/`createWriteStream` (a
minimal emitter — `.pipe()` delivers bytes and ends cleanly, and a missing source
emits `error` rather than throwing); and a `window.Buffer` shim (a `Uint8Array`
subset — `Buffer.from`, `new Buffer`, base64 round-trips) because the bundled
Live2D/Wasm loader resolves `Buffer` off `globalThis` via
`_getAttributeFromParentPages('Buffer')`. `window.require` (already the Task 4
fix) is what makes `os.platform` and `W26_WindowsFullName.get()` succeed.

`renameSync`/`rmdirSync` are **not** read-only members: they call the host's
`rename(path, toPath)` / `rmdir(path)` and turn a `false` reply into Node's error
(`ENOENT`/`ENOTEMPTY`/`ENOTDIR`/`EACCES`). On device that makes them real
(`File.renameTo` / `File.delete`); in the headless in-page host they are logged
no-ops. See "Host contract extended" below.

**`fetch` was deliberately *not* overridden.** The only `fetch(` call site in the
engine is `fetch('https://api.ip.sb/geoip')` (`rv.js:92561`); the other
occurrences live inside the WAsm loader behind `typeof fetch` guards. The host
never serves local files through `fetch`, so there is nothing to shim. If a
future engine build does read local files with `fetch`, override `window.fetch`
in the init script at that point rather than pre-emptively.

### Residual, expected output (none of it a `pageerror`)

- `43` `[requestfailed]` lines, **none a port defect**. Only **3** are
  genuinely missing Demo assets (`asset/image/picture/control/btn_normal.png`,
  `btn_over.png`, `btn_click.png`; the folder holds only scrollbar/checkbox/tab
  art). The other **40** are:
  - first-run-missing `savedata/` state — `savedata/life.gcdata`,
    `savedata/life.gcdatabak`, and the `savedata` directory itself (repeated a
    few times as the engine probes);
  - `asset/json/ui/uiCompSetting.json` — the `asset/json/ui/` directory does not
    exist in this build;
  - the docs-root `…/爱之巢/logs` directory (never created headless);
  - write-then-read-back paths under gameRoot — `\AppData\Roaming\cicigames…`,
    `\Desktop\…`, `晴小姐\日记.txt` — which fail *only* because no-op writes
    discard them.

  All decode to `ERR_FILE_NOT_FOUND` (i.e. *absence*, not path mangling of an
  existing asset), so no existing game file is being mis-addressed.
- `22` `[host:…]` no-op / Android-capability log lines — proof the host was
  actually called.
- Offline `当前城市: Tiruvānmiyūr` (geoip) and the `gamecreator.com.cn` OpenAPI
  banner — spec risk #6, expected.
- `writeBase64` was exercised (e.g. `life.gcdatabak`, 1836/3348 b64 chars) with
  no error — the write path runs; it simply discards, because in-page writes are
  no-ops by design. **This is a real limitation of the headless host: it cannot
  verify that saves actually persist.** Persistence is Task 7/9's job on-device.

### Host contract extended (Fix round 1) — `rename` / `rmdir`

The original Task 5 `renameSync`/`rmdirSync` validated paths and then reported
success **without calling the host**. That is fine-ish headless, but the same
`gc-bridge.js` runs on device, so a "successful" rename or rmdir would change
nothing there — and the engine really does call both
(`renameSync` @`script.js` char 8696204, `rmdirSync` @4520184). Extending the
`__GCNative` interface with two members fixes this at the source:

| Host method | Bridge semantics on `false` |
|---|---|
| `rename(path, toPath) -> Boolean` | `ENOENT` when the source is missing, `EACCES` on an escape (either end) |
| `rmdir(path) -> Boolean` | `ENOENT` missing, `ENOTDIR` not a dir, `ENOTEMPTY` non-empty dir, `EACCES` on an escape |

`inpage-host.js` exposes both as logged no-ops returning `true` (consistent with
its `writeBase64`/`mkdirp`/`unlink`), so the headless run keeps passing and stays
a faithful twin of `GameBridge.kt`.

> **`host-native.js` (the Task 1 Node host) was deliberately not touched** — it
> is a committed interface artifact. It still exposes 19 methods, so it is one
> phase behind the extended 21-method contract. `bridge.test.js` supplies
> `rename`/`rmdir` on the host it constructs for the mutation tests. **`GameBridge.kt`
> (Task 7) must implement `rename(path, toPath)` and `rmdir(path)`** (e.g.
> `File.renameTo` / `File.delete`) or save rotation silently loses saves on device.

### `accessSync` ignores `mode` (recorded limitation)

`fs.accessSync`/`access` map any `mode` to a plain existence check, because the
host only exposes reachability. So `W_OK` reports every existing file as
writable, and a genuine on-device write-permission failure (`EACCES`) would be
masked. Nothing in the current engine relies on a `W_OK` failure, but this is a
known fidelity gap, not a guarantee.

### Environmental console patterns treated as non-errors (Fix round 1)

`run.js`'s `isEnvironmental()` anchors on the exact three shapes the
headless/SwiftShader layer emits, matched per line of the `pageerror` text:

```
WebGL: CONTEXT_LOST_WEBGL:
[.WebGL-<hex>]GL Driver Message (<backend, …>): GPU stall
shader error null
```

A bare `shader` / `GPU` substring match was rejected: a real engine error that
merely mentioned those words would have been silently reclassified. In the
reviewed runs the environmental count is `0` (the context loss surfaces as a
console warning, not a `pageerror`), so the green result does not depend on this
filter at all.

### WebGL is blank here — environmental, not a port regression

The injected run still emits `CONTEXT_LOST_WEBGL` (×1) and `shader error null`
(×6) as **console** lines, and `out/screenshot.png` is a 6738-byte blank white
frame. This is **not** caused by the shim: baseline B shows the identical
context loss, and a sweep of launch flags changed nothing — default,
`--use-gl=angle --use-angle=swiftshader`, `--enable-unsafe-swiftshader`, both
combined, `--disable-gpu`, `--use-gl=swiftshader`, and even **headed under
`xvfb-run`** all produce the same `lost:1, shader:6, size:6738` blank frame.
Because no `run.js` launch arg helps, none was added — faking a visual check or
swallowing the signal would be dishonest. The acceptance gate for Task 5 is
therefore **zero engine `pageerror`s plus the three assertions above**, which is
met; "the title screen is visibly drawn" cannot be confirmed on this machine and
is recorded as a concern.

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

## `transition-probe.js` and the black-screen root cause

`transition-probe.js` boots the real game in Chromium, drives it past the title
(curtain), then asks the engine about its own state: Laya stage tree, loader
pending list, worker count, framebuffer samples, and the full XHR timeline.

`--ua-mobile` is the **regression harness for the phone's black screen**. It
reports the device's Android WebView user agent *before* Laya reads it, so Laya
computes `onMobile = true` / `onPC = false` by itself — no property is forced, so
nothing fights the shim. In that mode the run stops exactly where the device
stops (same last request, no post-load host call, every post-load landmark
false). With the fix in `gc-bridge.js` it matches the healthy desktop baseline
request for request.

`--host-stack` (or `LOVENEST_HOSTSTACK=1`) wraps every `__GCNative` method to
record `new Error().stack` per host call. That is how the root cause was found:
the frames carry real engine function names (`FileUtils.taskF`, `SyncTask.func`,
`createDirectoryForce`) and `<anonymous>:line:col` positions that line up with
the percent-decoded `script.js`. It writes `out/host-stacks.txt`.

The other flags (`--btn-mode`, `--worker-mode`, `--patch-objectutils`,
`--no-webgl`) are the earlier falsified hypotheses kept for reference — none of
them reproduce the device stall.
