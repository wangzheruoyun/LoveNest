package com.github.wangzheruoyun.lovenest

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Debug
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.SequenceInputStream
import java.util.Collections
import org.json.JSONObject

/**
 * How `gc-bridge.js` gets in front of the engine.
 *
 * - [INTERCEPT_SCRIPT] (default) intercepts the `script.js` response and prefixes
 *   the shim to it. `location.href` stays on the real `index.html`, which is the
 *   most faithful arrangement.
 * - [LAUNCHER_HTML] loads a small synthetic page that pulls the same files in the
 *   same order, but gives the document the game's own `index.html` URL as its base
 *   and history URL, so the engine's `location.pathname`-derived asset root points
 *   at the game folder. This is the design's documented fallback for the risk that
 *   `shouldInterceptRequest` is not invoked for `file://` subresources on some
 *   Android version. It is insurance, not a second architecture.
 *
 * Switch by changing [MainActivity.INJECTION_MODE].
 */
private enum class InjectionMode { INTERCEPT_SCRIPT, LAUNCHER_HTML }

/**
 * WebView host for the Love Nest demo.
 *
 * Responsibilities, in the order they matter:
 *
 *  1. **Get the shim into the page** so the engine's platform probe sees
 *     `window.require` and `location.href` starting with `file` and therefore
 *     selects `os.platform = 2` (PC). On platform 3 the Meta performances and the
 *     filesystem save system are dead. See [InjectionMode].
 *  2. **Prove it happened.** `os.platform = 3` is the single worst silent
 *     failure of this port, so [verifyBridge] checks the live page shortly after
 *     load and shouts in logcat *and* on screen if it did not take.
 *  3. **Own what the engine's Cordova branch would have done** (design §2.5):
 *     immersive full screen, landscape lock, keep-awake, synthetic
 *     `pause`/`resume` events.
 *  4. **Ask for "all files access"** and explain itself when it is missing or the
 *     game folder is not where it should be.
 *
 * The game folder itself is never written to and never copied: the shim and the
 * native host read it in place through the paths the user's own device provides.
 */
class MainActivity : Activity() {

    private lateinit var container: FrameLayout
    private lateinit var gate: LinearLayout
    private lateinit var gateTitle: TextView
    private lateinit var gateMessage: TextView
    private lateinit var gateButton: Button

    private var webView: WebView? = null
    private var gameBridge: GameBridge? = null
    private var gameStarted = false
    private var bridgeFailureReported = false
    private var exitDialogShowing = false

    /* ---- Task 11 diagnostics ------------------------------------------ */

    /** The diagnostic session, or null if it could not be opened at all. */
    private var diag: Diag? = null

    /** Drives the heartbeat/watchdog tick; created lazily, stopped in onDestroy. */
    private var watchdogHandler: Handler? = null

    /** True while a heartbeat `evaluateJavascript` has been issued but not answered. */
    private var heartbeatPending = false

    /** When the outstanding heartbeat was issued, for the "missing" line's age. */
    private var heartbeatSentAt = 0L

    /** Ticks since the session started, so memory is sampled every 5s. */
    private var watchdogTicks = 0

    /** Set by `onRenderProcessGone`; read by the heartbeat line as H1 evidence. */
    private var renderProcessGone = false

    /* ---- Task 12 STALL detection ------------------------------------- */

    /** Last `rafFired` seen by the watchdog; the differential's frozen half. */
    private var lastRafFired = 0L

    /** True once the engine has delivered at least one animation frame. */
    private var rafFiredSeen = false

    /** Consecutive samples where `rafFired` did not advance while `hb` did. */
    private var rafStallSamples = 0

    /** Last `hb`, so a STALL is only claimed while the page is demonstrably alive. */
    private var lastHb = -1L

    /** True once a STALL verdict has been reached for this session. */
    private var stallReported = false

    /** Guards `STALL` so exactly one record is written per session. */
    private var stallRecordWritten = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Start the log before anything else, so the boot sequence is on disk
        // even if the game never reaches its title screen.
        diag = try {
            Diag.start(this, GAME_ROOT, docsRootPath(), INJECTION_MODE.name)
        } catch (_: Exception) {
            null
        }
        diag?.log("LIFECYCLE created")
        buildUi()
        applyImmersive()
        updateGate()
    }

    /* ------------------------------------------------------------------ *
     * Permission / game-folder gate
     * ------------------------------------------------------------------ */

    /**
     * Decide between showing an explanation and starting the game. Called on
     * create and again on every resume, so returning from Settings re-checks.
     */
    private fun updateGate() {
        if (gameStarted) return
        when {
            !hasStorageAccess() -> showGate(
                R.string.gate_permission_title,
                getString(R.string.gate_permission_message),
                R.string.gate_permission_button,
            )

            !gameIndex.isFile -> showGate(
                R.string.gate_missing_title,
                getString(R.string.gate_missing_message, GAME_ROOT),
                R.string.gate_missing_button,
            )

            else -> {
                gate.visibility = View.GONE
                startGame()
            }
        }
    }

    private fun showGate(titleId: Int, message: String, buttonId: Int) {
        gate.visibility = View.VISIBLE
        gateTitle.setText(titleId)
        gateMessage.text = message
        gateButton.setText(buttonId)
    }

    /**
     * Android 11+ gates the game folder behind "all files access". On the 8.0-10
     * range `minSdk` claims, the same reach is the legacy external-storage
     * runtime grant, so the button asks for whichever applies and success is
     * re-tested on return.
     */
    private fun hasStorageAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        }

    private fun requestStorageAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val appSettings = Intent(
                Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:$packageName"),
            )
            try {
                startActivity(appSettings)
            } catch (_: ActivityNotFoundException) {
                // A few ROMs only expose the list-level page.
                try {
                    startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                } catch (_: Exception) {
                    toast(getString(R.string.gate_settings_unavailable))
                }
            }
        } else {
            requestPermissions(
                arrayOf(
                    Manifest.permission.READ_EXTERNAL_STORAGE,
                    Manifest.permission.WRITE_EXTERNAL_STORAGE,
                ),
                LEGACY_STORAGE_REQUEST,
            )
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == LEGACY_STORAGE_REQUEST) updateGate()
    }

    /* ------------------------------------------------------------------ *
     * WebView
     * ------------------------------------------------------------------ */

    private fun startGame() {
        if (gameStarted) return
        gameStarted = true
        renderProcessGone = false

        val view = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = true
                allowFileAccessFromFileURLs = true

                // Deliberate, informed trade-off. Android's security guidance says
                // to leave allowUniversalAccessFromFileURLs OFF because it opens a
                // file://-based XSS surface. Love Nest loads only local files the
                // user already has on their own device - no remote content and no
                // external input reach this WebView - so that surface does not
                // exist here. See design doc §5.3. No CSP headers are sent: the
                // engine depends on eval.
                allowUniversalAccessFromFileURLs = true

                mediaPlaybackRequiresUserGesture = false
            }

            // The engine's Cordova-vibrate branch is unreachable on platform 2;
            // the shim routes what it can here instead.
            val bridge = GameBridge(this@MainActivity, GAME_ROOT, docsRootPath(), diag)
            gameBridge = bridge
            addJavascriptInterface(bridge, JS_INTERFACE_NAME)

            webViewClient = GameWebViewClient()
            webChromeClient = GameWebChromeClient()
        }

        webView = view
        container.addView(
            view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        when (INJECTION_MODE) {
            // Keep the URL the engine sees: file:///…/index.html, so its platform
            // probe (`location.href.indexOf("file") == 0`) holds.
            InjectionMode.INTERCEPT_SCRIPT -> view.loadUrl(gameIndexUrl())

            // The fallback. `loadDataWithBaseURL` (not a `filesDir` page) makes the
            // document's own URL the game's `index.html` - see [launcherHtml] for why
            // that is the whole point.
            InjectionMode.LAUNCHER_HTML -> view.loadDataWithBaseURL(
                gameIndexUrl(),   // base URL: relative script/asset URLs resolve here
                launcherHtml(),
                "text/html",
                "UTF-8",
                gameIndexUrl(),   // history URL: the document's own URL
            )
        }

        startWatchdog()
    }

    /* ------------------------------------------------------------------ *
     * Task 11 — native-side observation
     * ------------------------------------------------------------------ */

    /**
     * Start the main-thread watchdog: a 1 s tick that polls the page heartbeat
     * every 2 s, names any `INFLIGHT` host call, and samples memory every 5 s.
     * The main looper is demonstrably alive even when the picture is black (the
     * back dialog still appears), so it is the one vantage point that survives
     * whatever the page did. Idempotent, so renderer recovery can restart it.
     */
    private fun startWatchdog() {
        if (diag == null) return
        val handler = watchdogHandler ?: Handler(Looper.getMainLooper()).also { watchdogHandler = it }
        handler.removeCallbacksAndMessages(null)
        watchdogTicks = 0
        heartbeatPending = false
        handler.postDelayed(watchdogTick, WATCHDOG_INTERVAL_MS)
    }

    private fun stopWatchdog() {
        watchdogHandler?.removeCallbacksAndMessages(null)
    }

    private val watchdogTick = object : Runnable {
        override fun run() {
            val log = diag ?: return
            watchdogTicks++

            if (watchdogTicks % HEARTBEAT_TICKS == 0) {
                val now = System.currentTimeMillis()
                // H2/H1 discriminator: is the renderer still answering at all?
                if (heartbeatPending) {
                    log.log(
                        "NATIVE_HB t=$now cb=missing for=${SystemClock.elapsedRealtime() - heartbeatSentAt}ms " +
                            "rendererAlive=${rendererAlive()}"
                    )
                } else {
                    probeHeartbeat(log, now)
                }

                // H2 discriminator: name the host call the JavaBridge thread is
                // parked inside. Only the native side can see this, because the
                // JS thread that would have written the matching `DONE` is
                // blocked. Re-logged while it persists, so the last line before
                // the file stops growing names the call.
                gameBridge?.inFlightDescription()?.let { desc ->
                    val split = desc.lastIndexOf(' ')
                    if (split > 0) {
                        val name = desc.substring(0, split)
                        val startedAt = desc.substring(split + 1).toLongOrNull() ?: 0L
                        val held = SystemClock.elapsedRealtime() - startedAt
                        if (held >= INFLIGHT_WARN_MS) {
                            log.log("INFLIGHT $name for ${held}ms")
                        }
                    }
                }
            }

            if (watchdogTicks % MEMORY_TICKS == 0) sampleMemory(log)

            watchdogHandler?.postDelayed(this, WATCHDOG_INTERVAL_MS)
        }
    }

    /**
     * Ask the page for its heartbeat counter and JS heap. One `evaluateJavascript`
     * gives both. A callback that never arrives is the H2 signal; the renderer
     * being gone is reported separately by [GameWebViewClient.onRenderProcessGone].
     */
    private fun probeHeartbeat(log: Diag, now: Long) {
        val view = webView ?: return
        heartbeatPending = true
        heartbeatSentAt = SystemClock.elapsedRealtime()
        try {
            view.evaluateJavascript(HEARTBEAT_JS) { raw ->
                heartbeatPending = false
                val payload = unwrapJsonString(raw)
                if (payload == null) {
                    log.log("NATIVE_HB t=$now hb=? cb=ok mem=null counters=missing")
                    return@evaluateJavascript
                }
                val hb = payload.optLong("hb", -1L)
                val mem = payload.optString("mem").orEmpty().ifEmpty { "null" }
                log.log(
                    "NATIVE_HB t=$now hb=" + (if (hb < 0) "?" else hb.toString()) +
                        " cb=ok mem=$mem" + heartbeatCounters(payload)
                )
                if (hb >= 0) detectStall(log, now, hb, payload)
            }
        } catch (e: Exception) {
            heartbeatPending = false
            log.log("NATIVE_HB t=$now cb=error detail=${e.javaClass.simpleName}")
        }
    }

    /**
     * The Task 12 counters, appended to every `NATIVE_HB` line so the log itself
     * carries the 甲/乙 decision without waiting for a STALL: `rafSched` climbing
     * against a frozen `rafFired` is 甲, a frozen `rafSched` against a climbing
     * `hb` is 乙, both climbing is "the engine is painting black".
     */
    private fun heartbeatCounters(payload: JSONObject): String =
        " rafSched=" + payload.optLong("rafSched", -1L) +
            " rafFired=" + payload.optLong("rafFired", -1L) +
            " ctxLost=" + payload.optLong("ctxLost", -1L) +
            " ctxRestored=" + payload.optLong("ctxRestored", -1L) +
            " ctxCreateErr=" + payload.optLong("ctxCreateErr", -1L) +
            " ctxLostPrevented=" + payload.optLong("ctxLostPrevented", -1L) +
            " audPlay=" + payload.optLong("audPlay", -1L) +
            " audioEl=" + payload.optLong("audioElements", -1L) +
            " audioPaused=" + payload.optLong("audioPaused", -1L) +
            " audioMaxT=" + payload.optDouble("audioMaxTime", -1.0) +
            " audioEnded=" + payload.optLong("audioEnded", -1L) +
            " audioCtx=" + payload.optString("audioContexts").ifEmpty { "[]" } +
            " pend=" + payload.optLong("pend", -1L) +
            " vis=" + payload.optString("visibility").ifEmpty { "unknown" } +
            // Task 13: GL activity per frame, and the WebAudio clock, so the
            // heartbeat itself distinguishes "painting black" from "not
            // painting" and "silent" from "audio graph dead".
            " draws=" + payload.optLong("draws", -1L) +
            " clear=" + payload.optLong("clear", -1L) +
            " texUp=" + payload.optLong("texUp", -1L) +
            " readPx=" + payload.optLong("readPx", -1L) +
            " absStart=" + payload.optLong("absStart", -1L) +
            " ctxTime=" + payload.optDouble("ctxTime", -1.0)

    /**
     * H3 vs 甲/乙: once the engine has delivered a frame, three consecutive
     * samples where `rafFired` does not advance while `hb` does are a `STALL`.
     * The user cannot press anything on a black screen, so this fires on its own.
     *
     * The single `STALL` record embeds the page-side dump (`__gcDiagDump()`):
     * pending request table, resource ring, audio state, canvas/GL facts. It is
     * written once, either when the dump returns or, if the page never answers,
     * with `dump=missing …` so the record still exists.
     */
    private fun detectStall(log: Diag, now: Long, hb: Long, payload: JSONObject) {
        val rafFired = payload.optLong("rafFired", -1L)
        if (rafFired >= 0) {
            if (rafFired > lastRafFired) {
                rafFiredSeen = true
                rafStallSamples = 0
            } else if (rafFiredSeen && hb > lastHb) {
                rafStallSamples++
            } else if (rafFiredSeen) {
                // The heartbeat is not advancing either: that is H1/H2 death,
                // not this instrument's case. Do not mislabel it as a STALL.
                rafStallSamples = 0
            }
            lastRafFired = rafFired
        }
        lastHb = hb

        if (!rafFiredSeen || rafStallSamples < STALL_SAMPLES || stallReported) return
        stallReported = true
        val counters = heartbeatCounters(payload) + " stalledSamples=" + rafStallSamples

        // Task 13: arm a framebuffer sample as well. If the engine's rAF has
        // genuinely frozen, the read will not run — the frozen `rafFired` in
        // `counters` already says so — but a sample that does fire proves the
        // engine was still drawing while the watchdog thought it had stalled.
        try {
            webView?.evaluateJavascript(SAMPLE_FB_STALL_JS, null)
        } catch (_: Exception) {
            // Observing must not interfere with the STALL record below.
        }

        val view = webView ?: run {
            reportStall(log, now, counters, "no-webview")
            return
        }
        var answered = false
        try {
            view.evaluateJavascript(DUMP_JS) { raw ->
                answered = true
                val data = unwrapJsonString(raw)?.toString() ?: "null"
                reportStall(log, now, counters, data)
            }
        } catch (e: Exception) {
            reportStall(log, now, counters, "error:${e.javaClass.simpleName}")
            return
        }
        watchdogHandler?.postDelayed({
            if (!answered) {
                reportStall(log, now, counters, "missing (no answer in ${STALL_DUMP_TIMEOUT_MS}ms)")
            }
        }, STALL_DUMP_TIMEOUT_MS)
    }

    /** Write the one `STALL` record, guarded so the callback/timeout cannot double it. */
    private fun reportStall(log: Diag, now: Long, counters: String, dump: String) {
        if (stallRecordWritten) return
        stallRecordWritten = true
        log.log("STALL t=$now$counters dump=$dump")
    }

    /**
     * `evaluateJavascript` wraps a returned string in JSON, so the value comes
     * back as `"{\"hb\":12,…}"`. Unwrap once, then parse the inner object.
     */
    private fun unwrapJsonString(raw: String?): JSONObject? {
        if (raw == null || raw == "null") return null
        return try {
            val inner = JSONObject("{\"v\":$raw}").optString("v")
            JSONObject(inner)
        } catch (_: Exception) {
            null
        }
    }

    /** Runtime + native heap, sampled on the main thread; never touches the page. */
    private fun sampleMemory(log: Diag) {
        val runtime = Runtime.getRuntime()
        val nativeHeap = try {
            Debug.getNativeHeapAllocatedSize()
        } catch (_: Exception) {
            -1L
        }
        val activityManager = getSystemService(ACTIVITY_SERVICE) as? ActivityManager
        val memoryInfo = ActivityManager.MemoryInfo()
        activityManager?.getMemoryInfo(memoryInfo)
        log.log(
            "MEM java_total=${runtime.totalMemory()} java_free=${runtime.freeMemory()} " +
                "java_max=${runtime.maxMemory()} native=$nativeHeap " +
                "sysAvail=${if (activityManager == null) -1L else memoryInfo.availMem} " +
                "lowMemory=${if (activityManager == null) false else memoryInfo.lowMemory}"
        )
    }

    /** Whether `onRenderProcessGone` has fired; set by the client below. */
    private fun rendererAlive(): Boolean = !renderProcessGone

    /**
     * The H1 verdict and the only recovery path: the renderer is gone, so the
     * `WebView` is unusable and must be rebuilt. Returning `true` stops the
     * platform from killing the app, which is what keeps the log readable and
     * lets the phone be recovered without reinstalling.
     */
    private fun onRendererGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
        renderProcessGone = true
        val crashed = try {
            detail?.didCrash() ?: true
        } catch (_: Exception) {
            true
        }
        diag?.log(
            "RENDERER_GONE crashed=$crashed didCrashKnown=${detail != null} " +
                "priorityAtExit=${try { detail?.rendererPriorityAtExit() ?: -1 } catch (_: Exception) { -1 }}"
        )
        stopWatchdog()
        // The dead WebView must not be reused; tear it down and offer a reload.
        try {
            webView?.let { dead ->
                (dead.parent as? ViewGroup)?.removeView(dead)
                dead.destroy()
            }
        } catch (_: Exception) {
            // Already gone.
        }
        webView = null
        gameStarted = false
        bridgeFailureReported = false
        showRendererGoneDialog()
        return true
    }

    private fun showRendererGoneDialog() {
        if (isFinishing || isDestroyed) return
        try {
            AlertDialog.Builder(this)
                .setTitle(R.string.renderer_gone_title)
                .setMessage(R.string.renderer_gone_message)
                .setPositiveButton(R.string.renderer_gone_reload) { _, _ ->
                    diag?.log("RENDERER_RELOAD requested")
                    startGame()
                }
                .setCancelable(false)
                .show()
        } catch (_: Exception) {
            // A dialog that cannot be shown must not wedge the app.
        }
    }

    private inner class GameWebChromeClient : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            diag?.log(
                "CONSOLE ${message.messageLevel()} ${message.message()} " +
                    "@ ${message.sourceId()}:${message.lineNumber()}"
            )
            return false
        }
    }

    private inner class GameWebViewClient : WebViewClient() {

        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? = interceptScript(request)

        override fun onPageFinished(view: WebView, url: String?) {
            super.onPageFinished(view, url)
            diag?.log("PAGE_FINISHED url=${url ?: ""}")
            view.postDelayed({ verifyBridge() }, BRIDGE_PROBE_DELAY_MS)
            view.postDelayed({ probeWebGl() }, WEBGL_PROBE_DELAY_MS)
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            super.onReceivedError(view, request, error)
            diag?.log(
                "PAGE_ERROR code=${error.errorCode} mainFrame=${request.isForMainFrame} " +
                    "desc=${error.description} url=${request.url}"
            )
        }

        /**
         * H1, the one outcome that actually requires action: the renderer is
         * dead, so nothing on the page can ever advance again.
         */
        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean =
            onRendererGone(view, detail)
    }

    /**
     * Probe the page's graphics capability once, so "the black screen is a
     * WebGL/rendering problem" can be excluded from the log rather than guessed
     * at: which context a plain canvas can actually get, and which driver the
     * debug extension reports.
     */
    private fun probeWebGl() {
        val view = webView ?: return
        view.evaluateJavascript(WEBGL_PROBE_JS) { raw ->
            diag?.log("WEBGL ${unwrapJsonString(raw) ?: "unavailable raw=${raw ?: "null"}"}")
        }
    }

    /* ------------------------------------------------------------------ *
     * Shim injection (design §5.2, Ruling C)
     * ------------------------------------------------------------------ */

    /**
     * Serve `script.js` as: alias, then the whole shim, then the real script.
     *
     * `index.html` runs `<script src="script.js?r=…">` and calls `main()`
     * afterwards, so prefixing is enough to guarantee the shim executes first -
     * and the game folder is never touched. The real bytes are streamed from
     * disk with a `SequenceInputStream`, so the 9.5 MB script is not decoded and
     * re-encoded (or held twice) in memory.
     */
    private fun interceptScript(request: WebResourceRequest): WebResourceResponse? {
        if (INJECTION_MODE != InjectionMode.INTERCEPT_SCRIPT) return null
        val url = request.url?.toString() ?: return null
        return try {
            // The URL -> file mapping (percent-decoding and containment) lives in
            // ScriptRequest, which routes containment through DirectFileSource.resolve
            // like every other path. It is inside the try so a malformed escape can
            // never escape as an exception.
            val script = ScriptRequest.fileFor(url, GAME_ROOT)
            if (script == null) {
                if (url.contains("/${ScriptRequest.FILE_NAME}")) {
                    Log.w(TAG, "ignoring an unresolved script.js request: $url")
                }
                return null
            }

            // Order matters: the alias must exist before the shim runs (it reads
            // `window.__GCNative` at its top), and the shim must exist before the
            // engine runs. The shim is streamed straight out of the APK's assets,
            // never off the game folder and never re-encoded, so the bytes served
            // are the bytes that shipped.
            val alias = ByteArrayInputStream("$WINDOW_NATIVE_ALIAS\n".toByteArray(Charsets.UTF_8))
            val shim = assets.open(SHIM_ASSET)
            val engine = FileInputStream(script)
            WebResourceResponse(
                "application/javascript",
                "UTF-8",
                SequenceInputStream(Collections.enumeration(listOf(alias, shim, engine))),
            )
        } catch (e: Exception) {
            // Returning null here is not silent: the page ends up without the
            // shim, and the Ruling D probe reports that loudly.
            Log.e(TAG, "could not serve the injected script.js; the engine will fall back to platform 3", e)
            null
        }
    }

    /** The URL the engine itself loads: `file:///…/index.html`, percent-encoded. */
    private fun gameIndexUrl(): String = Uri.fromFile(gameIndex).toString()

    /**
     * The documented fallback launcher (design §5.2), loaded with
     * `loadDataWithBaseURL` rather than from a file in `filesDir`.
     *
     * The engine derives *where assets live* from `location.pathname`, not from a
     * `<base href>`:
     *
     * ```
     * pathName = location.pathname;                    // the document's own URL
     * URL.rootPath = URL.basePath = URL.getPath(pathName);   // dir of pathname
     * ... return (base || URL.basePath) + url;         // every asset URL
     * ```
     *
     * So a page at `file:///data/user/0/<pkg>/files/launcher.html` would resolve every
     * asset under `filesDir` and 404 - while still booting on platform 2, i.e. silently.
     * Passing the game's `index.html` URL as both the base **and** the history URL makes
     * `location.pathname` the game path, so `URL.basePath` is the game root and relative
     * `script.js` / asset URLs resolve there. `location.href` still starts with `file`,
     * so platform detection still yields 2. Nothing is written to disk.
     */
    private fun launcherHtml(): String = """
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="utf-8"/>
        <script>$WINDOW_NATIVE_ALIAS</script>
        <script src="file:///android_asset/gc-bridge.js"></script>
        </head>
        <body style="margin:0;background:#000">
        <script src="script.js?r=1"></script>
        <script>if (typeof main != 'undefined') { main(); } else { console.trace('main is undefined'); }</script>
        </body>
        </html>
    """.trimIndent()

    /* ------------------------------------------------------------------ *
     * Ruling D: make a platform-3 fallback impossible to miss
     * ------------------------------------------------------------------ */

    /**
     * Ask the live page whether the shim actually took, and whether the page can
     * reach a real asset.
     *
     * `window.AndroidBridge` is registered independently of the injection, so
     * this probe can report the failure even in the exact case where the shim
     * never loaded. It is deliberately non-fatal: it never throws and never
     * blocks the game, it only makes the silent platform-3 fallback (no Meta
     * performances, saves quietly routed to IndexedDB) loud - a logcat line for
     * the developer and a toast for whoever is holding the phone. The jQuery-free
     * asset probe inside [BRIDGE_PROBE_JS] reports its own outcome the same way
     * (logcat + toast), so "platform 2 but no assets" cannot hide either.
     */
    private fun verifyBridge() {
        val view = webView ?: return
        view.evaluateJavascript(BRIDGE_PROBE_JS, ValueCallback { raw ->
            // The probe returns a plain ASCII token, so all the JSON wrapping
            // `evaluateJavascript` adds is the surrounding quotes.
            val result = raw?.trim('"').orEmpty()
            if (result == BRIDGE_PROBE_OK) {
                Log.d(TAG, "gc-bridge active: $result")
                return@ValueCallback
            }
            if (bridgeFailureReported) return@ValueCallback
            bridgeFailureReported = true
            val detail = result.ifEmpty { "probe returned nothing" }
            Log.e(
                TAG,
                "gc-bridge is NOT active ($detail): the engine has fallen back to " +
                    "platform 3, so Meta performances and the file save system are disabled",
            )
            toast(getString(R.string.bridge_missing, detail))
        })
    }

    /* ------------------------------------------------------------------ *
     * Immersive / lifecycle
     * ------------------------------------------------------------------ */

    private fun applyImmersive() {
        // The game has no other way to stay awake: its Cordova insomnia branch is
        // unreachable on platform 2.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.hide(WindowInsets.Type.systemBars())
                controller.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                )
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Task 12: "Chromium thinks the page is occluded" must be excludable
        // from the record, so the Activity's own focus state is on disk.
        diag?.log("WINDOW_FOCUS hasFocus=$hasFocus")
        if (hasFocus) applyImmersive()
    }

    override fun onResume() {
        super.onResume()
        diag?.log("LIFECYCLE resume gameStarted=$gameStarted")
        // Backgrounding can leave a `screenOff()` brightness override in place
        // (a window attribute survives pause), so always drop it on the way back.
        gameBridge?.restoreScreenBrightness()
        if (gameStarted) dispatchDocumentEvent("resume") else updateGate()
    }

    override fun onPause() {
        diag?.log("LIFECYCLE pause gameStarted=$gameStarted")
        // Same reason as onResume: never leave the window black behind us.
        gameBridge?.restoreScreenBrightness()
        if (gameStarted) dispatchDocumentEvent("pause")
        super.onPause()
    }

    /**
     * `offMonitor`'s `scrnsave.scr /s` blackout ends on the player's next
     * interaction, exactly like a screensaver. Android reports every touch or
     * key here regardless of what consumes it, so this is a reliable "the user
     * did something" hook.
     */
    override fun onUserInteraction() {
        super.onUserInteraction()
        gameBridge?.restoreScreenBrightness()
    }

    private fun dispatchDocumentEvent(name: String) {
        val view = webView ?: return
        view.evaluateJavascript(
            "(function(){try{var e=document.createEvent('Event');" +
                "e.initEvent('$name',true,true);document.dispatchEvent(e);}catch(err){}})();",
            null,
        )
    }

    override fun onDestroy() {
        stopWatchdog()
        webView?.destroy()
        webView = null
        diag?.log("LIFECYCLE destroy")
        diag?.close()
        super.onDestroy()
    }

    /* ------------------------------------------------------------------ *
     * Back button (Task 10 Step 2)
     * ------------------------------------------------------------------ */

    /**
     * The design gives the system back gesture two duties, in this order:
     *
     *  1. Hand it to the in-game UI if the engine listens for it - a synthetic
     *     Escape `keydown` on the document, which reaches `document` and `window`
     *     listeners by bubbling.
     *  2. Regardless of whether the engine reacted (we cannot know: the script
     *     dispatch is fire-and-forget), ask the player before leaving. Back must
     *     never silently kill a running game with unsaved state.
     *
     * The engine's own quit path is untouched: `nircmd shutdown` still works
     * because it goes through [GameBridge.fakeShutdown], which calls `finish()`
     * directly and never comes through here.
     *
     * `onBackPressed` (not `OnBackPressedDispatcher`) is deliberate: this is a
     * plain `Activity` and the manifest does not opt into predictive back
     * (`android:enableOnBackInvokedCallback`), so the platform still delivers the
     * legacy callback. Pulling in `androidx.activity` for the dispatcher would be
     * a new runtime dependency for no behavioural gain.
     */
    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (!gameStarted) {
            // The gate screen has no game state to protect.
            super.onBackPressed()
            return
        }
        dispatchEscapeKey()
        confirmExit()
    }

    /* ------------------------------------------------------------------ *
     * Task 12 — volume keys (diagnostic build only)
     *
     * The Activity's key path is alive even when the page is not (the back key
     * already proves it), and the WebView may otherwise eat a volume key. So
     * the keys are intercepted here, before the view hierarchy:
     *
     *   volume-down → write the same dump `__gcDiagDump()` returns, immediately
     *   volume-up   → simulate a WebGL context loss on the engine's canvas
     *
     * Both are acceptable **only in this diagnostic build** and must be removed
     * before the final release. [CAPTURE_VOLUME_KEYS] is the single switch.
     * ------------------------------------------------------------------ */

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (CAPTURE_VOLUME_KEYS && gameStarted && diag != null && webView != null &&
            event.action == KeyEvent.ACTION_DOWN
        ) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_VOLUME_DOWN -> {
                    dumpOnDemand()
                    return true
                }

                KeyEvent.KEYCODE_VOLUME_UP -> {
                    // Ignore auto-repeat: one loss per press, not per repeat tick.
                    if (event.repeatCount == 0) {
                        simulateContextLoss()
                        return true
                    }
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /** Volume-down: write the page dump to the log right now. */
    private fun dumpOnDemand() {
        val log = diag ?: return
        val view = webView ?: return
        log.log("DUMP source=volume-down")
        // Task 13: arm a framebuffer sample; it runs inside the engine's next
        // rAF frame and writes its own `FB sample …` line.
        try {
            view.evaluateJavascript(SAMPLE_FB_DUMP_JS, null)
        } catch (_: Exception) {
            // A missing sample must not stop the dump below.
        }
        try {
            view.evaluateJavascript(DUMP_JS) { raw ->
                val data = unwrapJsonString(raw)?.toString() ?: "null"
                log.log("DUMP source=volume-down data=$data")
            }
        } catch (e: Exception) {
            log.log("DUMP source=volume-down data=error:${e.javaClass.simpleName}")
        }
    }

    /** Volume-up: ask the page to lose and restore the engine's WebGL context. */
    private fun simulateContextLoss() {
        val log = diag ?: return
        val view = webView ?: return
        log.log("CTXSIM requested source=volume-up")
        try {
            view.evaluateJavascript(LOSE_CONTEXT_JS) { raw ->
                log.log("CTXSIM result=" + (raw?.trim('"') ?: "null"))
            }
        } catch (e: Exception) {
            log.log("CTXSIM result=error:${e.javaClass.simpleName}")
        }
    }

    /** Fire the synthetic Escape and forget about it. Never throws. */
    private fun dispatchEscapeKey() {
        val view = webView ?: return
        view.evaluateJavascript(BACK_KEY_JS, null)
    }

    private fun confirmExit() {
        if (exitDialogShowing || isFinishing || isDestroyed) return
        exitDialogShowing = true
        try {
            AlertDialog.Builder(this)
                .setTitle(R.string.exit_confirm_title)
                .setMessage(R.string.exit_confirm_message)
                .setPositiveButton(R.string.exit_confirm_exit) { _, _ -> finish() }
                .setNegativeButton(R.string.exit_confirm_cancel, null)
                // Cancel (or back on the dialog) lands here too, so the dialog can
                // be reopened on the next press.
                .setOnDismissListener { exitDialogShowing = false }
                .show()
        } catch (_: Exception) {
            // A dialog that cannot be shown must not wedge the back button.
            exitDialogShowing = false
        }
    }

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    private val gameIndex: File get() = File(GAME_ROOT, "index.html")

    /**
     * `Documents/<game folder>` (design §5.6 / brief Step 4). The engine then
     * appends its own `Documents/<game name>/…` under it, so saves land in a
     * stable, deterministic place that survives reinstalling the app.
     */
    @Suppress("DEPRECATION")
    private fun docsRootPath(): String = File(
        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
        GAME_FOLDER_NAME,
    ).absolutePath

    private fun toast(message: String) {
        try {
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        } catch (_: Exception) {
            // Nothing sensible to do if even a toast fails.
        }
    }

    private fun buildUi() {
        val pad = (16 * resources.displayMetrics.density).toInt()

        gateTitle = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 20f
            gravity = Gravity.CENTER
        }
        gateMessage = TextView(this).apply {
            setTextColor(Color.LTGRAY)
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(0, pad / 2, 0, pad / 2)
        }
        gateButton = Button(this)
        gateButton.setOnClickListener {
            // One button, two meanings, decided by the live state: re-check when
            // the folder may have appeared, otherwise ask for access.
            if (hasStorageAccess()) updateGate() else requestStorageAccess()
        }

        gate = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
            addView(gateTitle)
            addView(gateMessage)
            addView(gateButton)
        }

        container = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(
                gate,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        setContentView(container)
    }

    private companion object {
        const val TAG = "LoveNest"

        /** The folder name the game ships as; also the documents sub-folder name. */
        const val GAME_FOLDER_NAME = "爱之巢DemoV1.52"

        /** Absolute game root, no trailing slash. */
        const val GAME_ROOT = "/storage/emulated/0/Download/$GAME_FOLDER_NAME"

        const val JS_INTERFACE_NAME = "AndroidBridge"
        const val LEGACY_STORAGE_REQUEST = 1001
        const val BRIDGE_PROBE_DELAY_MS = 500L

        /* ---- Task 11 watchdog cadence (all main-looper) ---- */

        /** Base tick of the watchdog runnable. */
        const val WATCHDOG_INTERVAL_MS = 1000L

        /** Poll the page heartbeat every 2 ticks (2 s). */
        const val HEARTBEAT_TICKS = 2

        /** Sample memory every 5 ticks (5 s). */
        const val MEMORY_TICKS = 5

        /** A host call held longer than this is named in an `INFLIGHT` line. */
        const val INFLIGHT_WARN_MS = 2000L

        /** How long after `onPageFinished` the one-off WebGL probe runs. */
        const val WEBGL_PROBE_DELAY_MS = 1500L

        /* ---- Task 12 STALL detection ---- */

        /**
         * Consecutive heartbeat samples where `rafFired` does not advance while
         * `hb` does before the watchdog writes its single `STALL` record. The
         * heartbeat runs every 2 s, so this is ~6 s of a frozen frame counter —
         * long enough that a slow frame cannot be mistaken for a stall, short
         * enough for one device run.
         */
        const val STALL_SAMPLES = 3

        /** How long a STALL waits for the page's `__gcDiagDump()` before logging `missing`. */
        const val STALL_DUMP_TIMEOUT_MS = 1500L

        /**
         * Task 12 diagnostic-build-only key capture: volume-down dumps the page
         * state, volume-up simulates a WebGL context loss.
         *
         * This is acceptable **only** in this diagnostic build and must be
         * switched off (or the `dispatchKeyEvent` override removed) before the
         * final release, so the shipped app keeps the platform's volume
         * behaviour. See the Task 12 report.
         */
        const val CAPTURE_VOLUME_KEYS = true

        /**
         * What `shouldInterceptRequest` prepends to `script.js` (Ruling C), plus
         * the Task 11 diagnostic opt-in. The flag must be set *before*
         * `gc-bridge.js` executes, which is exactly what this prefix guarantees;
         * with it absent the shim's diagnostic paths are inert.
         */
        const val WINDOW_NATIVE_ALIAS =
            "window.__GCNative = window.AndroidBridge;\n" +
                "window.__gcDiag = true;"

        /** The shim, served out of the APK's assets - never off the game folder. */
        const val SHIM_ASSET = "gc-bridge.js"

        /**
         * One page round trip that yields the heartbeat counter the shim
         * increments every 250 ms, `performance.memory` when the WebView exposes
         * it, and the Task 12 counters (rAF differential, context loss, audio,
         * pending requests). The shim's counters are deliberately independent of
         * the engine, so they keep advancing if only the engine's own loop died.
         */
        const val HEARTBEAT_JS = """
            (function () {
              var out = { hb: null, mem: null };
              try { out.hb = window.__gcHeartbeat; } catch (e) {}
              try {
                if (window.performance && window.performance.memory) {
                  var m = window.performance.memory;
                  out.mem = m.usedJSHeapSize + '/' + m.totalJSHeapSize + '/' + m.jsHeapSizeLimit;
                }
              } catch (e) {}
              try {
                if (window.__gcDiagCounters) {
                  var c = window.__gcDiagCounters();
                  for (var k in c) {
                    if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
                  }
                }
              } catch (e) {}
              return JSON.stringify(out);
            })();
        """

        /**
         * The on-demand dump: the pending request table, the resource ring
         * buffer, audio state, canvas/GL facts and every counter, as one JSON
         * string. Used by volume-down and by the STALL record.
         */
        const val DUMP_JS = """
            (function () {
              try {
                if (window.__gcDiagDump) return window.__gcDiagDump();
              } catch (e) {}
              return null;
            })();
        """

        /**
         * Task 13: arm a framebuffer sample. The page only sets a flag here;
         * the `readPixels` grid runs inside the engine's next requestAnimation-
         * Frame callback and writes its own `FB sample …` line (see
         * `diagRunCanvasSample` in the shim for why a timer must not read).
         */
        const val SAMPLE_FB_STALL_JS = """
            (function () {
              try {
                if (window.__gcDiagSampleCanvas) {
                  window.__gcDiagSampleCanvas('stall');
                  return true;
                }
              } catch (e) {}
              return false;
            })();
        """

        const val SAMPLE_FB_DUMP_JS = """
            (function () {
              try {
                if (window.__gcDiagSampleCanvas) {
                  window.__gcDiagSampleCanvas('volume-down');
                  return true;
                }
              } catch (e) {}
              return false;
            })();
        """

        /**
         * Volume-up: lose the engine's WebGL context through
         * `WEBGL_lose_context`, restore it after 2 s, and let the shim log what
         * the engine does. A device-local reproduction loop for the black screen
         * that does not need the scene transition.
         */
        const val LOSE_CONTEXT_JS = """
            (function () {
              try {
                if (window.__gcDiagLoseContext) return window.__gcDiagLoseContext();
              } catch (e) {}
              return 'unavailable';
            })();
        """

        /**
         * Which graphics contexts a plain canvas can actually obtain, and the
         * driver behind them, so a rendering-capability cause for the black
         * screen can be excluded from the log rather than guessed at.
         */
        const val WEBGL_PROBE_JS = """
            (function () {
              var out = { webgl: false, webgl2: false, vendor: null, renderer: null, error: null };
              try {
                // A canvas that has already handed out a `webgl` context can
                // never yield a `webgl2` one, so each context type gets its own
                // canvas. (The old single-canvas probe always reported
                // `webgl2:false` — that was this probe's bug, not the device's.)
                var glCanvas = document.createElement('canvas');
                var gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
                out.webgl = !!gl;
                if (gl) {
                  var ext = gl.getExtension('WEBGL_debug_renderer_info');
                  if (ext) {
                    out.vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL));
                    out.renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
                  } else {
                    out.vendor = String(gl.getParameter(gl.VENDOR));
                    out.renderer = String(gl.getParameter(gl.RENDERER));
                  }
                }
                var gl2Canvas = document.createElement('canvas');
                out.webgl2 = !!gl2Canvas.getContext('webgl2');
              } catch (e) {
                out.error = String(e && e.message ? e.message : e);
              }
              return JSON.stringify(out);
            })();
        """

        /**
         * The synthetic Escape dispatched when the player presses back, before the
         * exit confirmation. Dispatched at `document.activeElement || document` with
         * `bubbles`, so a listener on the element, on `document`, or on `window` all
         * see it. `keyCode`/`which` are legacy read-only accessors, so the branch
         * that still reads them gets them pinned explicitly; the ancient
         * `createEvent` fallback covers a WebView too old for `KeyboardEvent`.
         */
        const val BACK_KEY_JS = """
            (function () {
              try {
                var e;
                try {
                  e = new KeyboardEvent('keydown', {
                    key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
                    bubbles: true, cancelable: true
                  });
                  try { Object.defineProperty(e, 'keyCode', { get: function () { return 27; } }); } catch (x) {}
                  try { Object.defineProperty(e, 'which', { get: function () { return 27; } }); } catch (x) {}
                } catch (x) {
                  e = document.createEvent('Event');
                  e.initEvent('keydown', true, true);
                  e.key = 'Escape';
                  e.keyCode = 27;
                  e.which = 27;
                }
                (document.activeElement || document).dispatchEvent(e);
              } catch (x) {}
            })();
        """

        /**
         * Which injection mechanism to use; `INTERCEPT_SCRIPT` is the default.
         * Change to `InjectionMode.LAUNCHER_HTML` if interception turns out not to
         * fire for `file://` subresources on the target device.
         */
        val INJECTION_MODE = InjectionMode.INTERCEPT_SCRIPT

        /**
         * Runs in the page after load and returns one plain ASCII token: `OK`
         * when the shim is live and the engine chose platform 2, otherwise a
         * `FAIL …` line naming what was wrong.
         *
         * It reads `window.os.platform` (the engine's own platform flag, exactly
         * as the headless harness asserts it) rather than the always-2
         * `Common.runPlatform` getter, which would mask the failure. Returning a
         * token instead of reporting through `AndroidBridge` keeps `GameBridge`
         * at exactly the 21 contract methods and lets the Kotlin side log at
         * error level.
         *
         * It also makes the *asset* silent failure impossible: it writes
         * `location.href` and `location.pathname` to logcat (through the
         * existing bridge `log` member), then requests one real game file
         * (`icon.png` at the game root) with an `Image`. If that fails it reports
         * through the bridge again - a logcat line **and** a Toast. A page that
         * boots on platform 2 but cannot resolve its own assets is exactly the
         * failure the fallback used to hide; it now announces itself. Nothing
         * here throws, and nothing blocks the game.
         */
        const val BRIDGE_PROBE_JS = """
            (function () {
              var requireOk = false;
              var platform = null;
              var href = '';
              var path = '';
              try { requireOk = (typeof window.require === 'function'); } catch (e) {}
              try {
                if (window.os && typeof window.os.platform !== 'undefined') platform = window.os.platform;
              } catch (e) {}
              try { href = String(location.href); } catch (e) {}
              try { path = String(location.pathname); } catch (e) {}

              function bridge() { try { return window.AndroidBridge; } catch (e) { return null; } }
              // `GameBridge.log` escalates the "FAILED to load" line below to
              // Log.e, so the one fatal case is visible as an error in logcat.
              function say(msg) { try { var b = bridge(); if (b && b.log) b.log(msg); } catch (e) {} }

              say('probe location.href=' + href + ' location.pathname=' + path);

              // Prove the page can actually reach a real game asset from wherever it
              // thinks it lives. Relative to the document URL, which is what the
              // engine's URL.basePath is derived from.
              try {
                var img = new Image();
                img.onload = function () { say('probe asset ok: ' + img.src); };
                img.onerror = function () {
                  say('probe asset FAILED to load: ' + img.src);
                  try {
                    var b = bridge();
                    if (b && b.toast) b.toast('游戏资源无法加载（资源路径错误）: ' + img.src);
                  } catch (e) {}
                };
                img.src = 'icon.png';
              } catch (e) {}

              if (requireOk && platform === 2) return 'OK';
              return 'FAIL require=' + requireOk + ' os.platform=' + platform;
            })();
        """

        /** The one token [BRIDGE_PROBE_JS] returns when the shim is live. */
        const val BRIDGE_PROBE_OK = "OK"
    }
}
