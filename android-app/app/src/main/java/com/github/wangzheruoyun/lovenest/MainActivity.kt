package com.github.wangzheruoyun.lovenest

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ValueCallback
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
    private var gameStarted = false
    private var bridgeFailureReported = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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
            addJavascriptInterface(
                GameBridge(this@MainActivity, GAME_ROOT, docsRootPath()),
                JS_INTERFACE_NAME,
            )

            webViewClient = GameWebViewClient()
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
    }

    private inner class GameWebViewClient : WebViewClient() {

        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? = interceptScript(request)

        override fun onPageFinished(view: WebView, url: String?) {
            super.onPageFinished(view, url)
            view.postDelayed({ verifyBridge() }, BRIDGE_PROBE_DELAY_MS)
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
        if (hasFocus) applyImmersive()
    }

    override fun onResume() {
        super.onResume()
        if (gameStarted) dispatchDocumentEvent("resume") else updateGate()
    }

    override fun onPause() {
        if (gameStarted) dispatchDocumentEvent("pause")
        super.onPause()
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
        webView?.destroy()
        webView = null
        super.onDestroy()
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

        /** What `shouldInterceptRequest` prepends to `script.js` (Ruling C). */
        const val WINDOW_NATIVE_ALIAS = "window.__GCNative = window.AndroidBridge;"

        /** The shim, served out of the APK's assets - never off the game folder. */
        const val SHIM_ASSET = "gc-bridge.js"

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
