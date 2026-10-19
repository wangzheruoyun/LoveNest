package com.github.wangzheruoyun.lovenest

import android.app.AlertDialog
import android.app.Activity
import android.app.WallpaperManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray

/**
 * The native host behind `window.AndroidBridge`, which `MainActivity` aliases to
 * `window.__GCNative`.
 *
 * It implements the `__GCNative` contract name-for-name: the same 24 methods the
 * headless host in `tools/headless/host-native.js` exposes, so `gc-bridge.js`
 * runs unchanged in Node and on the phone. The shim calls these *synchronously*
 * from its `fs` / `os` / `child_process` / `nw.gui` shims, so every member here
 * is a plain blocking call - no callbacks, no async replies.
 *
 * Two rules apply to every member:
 *
 *  1. **Never throw across the boundary.** A refusal is `null` / `false` /
 *     `""` / `"[]"`, which the shim turns into a Node-shaped error. An exception
 *     escaping into the WebView bridge is a bug, so every body is guarded.
 *  2. **Every path goes through [DirectFileSource.resolve].** That is the single
 *     authority for containment (plan Ruling 1): a path outside the game root or
 *     the documents root is refused, not reinterpreted.
 *
 * Writes are allowed under the game root, matching the harness: Task 5 settled
 * that the host rejects only escaping paths, and that a GameBridge-only
 * read-only rule would make the device diverge from the harness. The 740 MB game
 * folder stays byte-identical because the engine derives every save path from
 * `os.homedir()` (the documents root) and because the headless contract test
 * asserts byte-identity after a representative workload.
 *
 * Methods are invoked on the WebView's JavaBridge thread, not the UI thread, so
 * anything that touches the UI is re-posted to the main looper.
 */
class GameBridge(
    private val activity: Activity,
    gameRoot: String,
    docsRoot: String,
    /**
     * The Task 11 diagnostic sink. `null` when no diagnostic session is
     * running, in which case every `diag?.log(...)` below is a no-op and the
     * bridge behaves exactly as it did before Task 11. It never affects the
     * value a member returns.
     */
    private val diag: Diag? = null,
) {

    private val game = DirectFileSource(File(gameRoot))
    private val docs = DirectFileSource(File(docsRoot))

    /**
     * Where a path becomes a file: game root first, then the documents root. The
     * composition lives in [RootedPathAuthority] so it is unit-tested without an
     * `Activity` - it is what decides where saves land.
     */
    private val paths = RootedPathAuthority(game, docs)

    private val main = Handler(Looper.getMainLooper())

    /**
     * The host member currently executing on the WebView's JavaBridge thread, or
     * `null`. Set by [tracked] around every `@JavascriptInterface` body and read
     * by the main-thread watchdog, which is the only way to name a call the JS
     * thread is parked inside: while a member runs, the JS thread cannot report
     * anything more, and the missing `DONE` line alone does not say *which*
     * member. Format: `"<name> <SystemClock.elapsedRealtime()>"`.
     */
    private val inFlight = AtomicReference<String?>(null)

    /**
     * True between [screenOff] and the next [restoreScreenBrightness], so the
     * activity's per-touch restore is a cheap no-op instead of a queued
     * runnable on every frame the player touches.
     */
    private val screenDimmed = AtomicBoolean(false)

    init {
        // The shim resolves save paths from os.homedir() == docsRoot(), and the
        // harness host creates it up front too. Creation is best-effort: without
        // "all files access" it fails, and the write members report that.
        try {
            File(docs.root()).mkdirs()
        } catch (_: Exception) {
            // Reported lazily by writeBase64 / mkdirp.
        }
    }

    /* ------------------------------------------------------------------ *
     * Roots
     * ------------------------------------------------------------------ */

    /** Absolute game root, no trailing slash. */
    @JavascriptInterface
    fun gameRoot(): String = tracked("gameRoot") { game.root() }

    /** Absolute documents root the engine treats as `os.homedir()`, no trailing slash. */
    @JavascriptInterface
    fun docsRoot(): String = tracked("docsRoot") { docs.root() }

    /* ------------------------------------------------------------------ *
     * Filesystem
     * ------------------------------------------------------------------ */

    @JavascriptInterface
    fun exists(path: String?): Boolean = tracked("exists") { resolve(path)?.exists() ?: false }

    @JavascriptInterface
    fun stat(path: String?): String? = tracked("stat") {
        val file = resolve(path) ?: return null
        try {
            if (!file.exists()) return null
            "{\"isDirectory\":${file.isDirectory},\"size\":${file.length()}}"
        } catch (_: Exception) {
            null
        }
    }

    @JavascriptInterface
    fun readBase64(path: String?): String? = tracked("readBase64") {
        val file = resolve(path) ?: return null
        if (!file.isFile) return null
        Base64Stream.encode(file)
    }

    @JavascriptInterface
    fun writeBase64(path: String?, b64: String?): Boolean = tracked("writeBase64") {
        val file = resolve(path) ?: return false
        val bytes = Base64Stream.decode(b64 ?: return false) ?: return false
        try {
            file.parentFile?.mkdirs()
            file.outputStream().use { it.write(bytes) }
            true
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun readDir(path: String?): String = tracked("readDir") {
        val entries = try {
            resolve(path)?.list()
        } catch (_: Exception) {
            null
        } ?: return "[]"
        try {
            val array = JSONArray()
            for (entry in entries) array.put(entry as Any)
            array.toString()
        } catch (_: Exception) {
            "[]"
        }
    }

    @JavascriptInterface
    fun mkdirp(path: String?): Boolean = tracked("mkdirp") {
        val file = resolve(path) ?: return false
        try {
            file.isDirectory || file.mkdirs()
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun unlink(path: String?): Boolean = tracked("unlink") {
        val file = resolve(path) ?: return false
        try {
            // `File.delete()` happily removes an empty directory; Node's
            // unlinkSync refuses one with EISDIR, so refuse it here too.
            if (file.isDirectory) false else file.delete()
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun rename(path: String?, toPath: String?): Boolean = tracked("rename") {
        val from = resolve(path) ?: return false
        val to = resolve(toPath) ?: return false
        try {
            from.renameTo(to)
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun rmdir(path: String?): Boolean = tracked("rmdir") {
        val file = resolve(path) ?: return false
        try {
            // `delete()` on a non-empty directory fails, like Node's rmdirSync.
            if (!file.isDirectory) false else file.delete()
        } catch (_: Exception) {
            false
        }
    }

    /* ------------------------------------------------------------------ *
     * Meta performances (design §5.6)
     * ------------------------------------------------------------------ */

    /**
     * The phone's owner-visible name, for the game's "read the real user name"
     * gag.
     *
     * Android exposes the user-set device name through `Settings.Global`, which
     * is the same name the owner sees in Settings and in a Bluetooth pairing -
     * the closest counterpart to `wmic useraccount`. It falls back to
     * [Build.MODEL]. The reply is forced to ASCII because the engine decodes it
     * through a GBK path.
     */
    @JavascriptInterface
    fun deviceName(): String = tracked("deviceName") {
        val configured = try {
            Settings.Global.getString(activity.contentResolver, Settings.Global.DEVICE_NAME)
        } catch (_: Exception) {
            null
        }
        val name = configured?.takeIf { it.isNotBlank() } ?: (Build.MODEL ?: "")
        asciiOnly(name)
    }

    /** `Android <release>`, ASCII-only, standing in for `wmic os get Caption`. */
    @JavascriptInterface
    fun androidVersion(): String = tracked("androidVersion") { asciiOnly(Build.VERSION.RELEASE ?: "") }

    /** Stand-in for `W26_DesktopWallpaper`: a real wallpaper change. */
    @JavascriptInterface
    fun setWallpaper(b64: String?): Boolean = tracked("setWallpaper") {
        val bytes = Base64Stream.decode(b64 ?: return false) ?: return false
        try {
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return false
            WallpaperManager.getInstance(activity).setBitmap(bitmap)
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Stand-in for the wallpaper *read* half of `W26_DesktopWallpaper`: it walks
     * `%APPDATA%\Microsoft\Windows\Themes` looking for the player's real
     * wallpaper, which has no Android equivalent path. There is no wallpaper to
     * read inside the app sandbox, so the phone's own wallpaper is handed back
     * instead — the same image the player sees on their home screen.
     *
     * `getBitmap()` would be simpler but only exists on API 27+ (`minSdk 26`), so
     * the wallpaper drawable is drawn into a fresh ARGB bitmap and re-encoded as
     * PNG, which is what the engine's `data:image/png;base64,…` expects.
     */
    @JavascriptInterface
    fun getWallpaper(): String? = tracked("getWallpaper") {
        try {
            val drawable = WallpaperManager.getInstance(activity).drawable ?: return null
            val width = drawable.intrinsicWidth
            val height = drawable.intrinsicHeight
            if (width <= 0 || height <= 0) return null
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            drawable.setBounds(0, 0, width, height)
            drawable.draw(Canvas(bitmap))
            val out = ByteArrayOutputStream()
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) return null
            Base64Stream.encode(out.toByteArray())
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Stand-in for `nircmd qboxcom "<content>" "<title>" consolewrite yes`: a real
     * yes/no dialog whose answer becomes the engine's `stdout`.
     *
     * The engine calls this *synchronously* from its command router on the
     * WebView's JavaBridge thread and branches on the returned boolean, so the
     * dialog is shown on the main thread while this (background) thread waits on
     * the answer. The wait is bounded, and an activity that is already gone
     * answers "no" immediately, so a question the user never answers can never
     * hang the game. A main-thread call returns `false` rather than deadlocking.
     */
    @JavascriptInterface
    fun confirm(title: String?, body: String?): Boolean = tracked("confirm") {
        if (Looper.myLooper() == Looper.getMainLooper()) return false
        if (activity.isFinishing || activity.isDestroyed) return false

        val answered = CountDownLatch(1)
        val yes = AtomicBoolean(false)
        // Set on the main thread when the dialog is created, so the timeout
        // branch can close the exact dialog this question put on screen.
        val dialogRef = AtomicReference<AlertDialog?>(null)
        main.post {
            try {
                if (activity.isFinishing || activity.isDestroyed) {
                    answered.countDown()
                    return@post
                }
                val dialog = AlertDialog.Builder(activity)
                    .setTitle(title ?: "")
                    .setMessage(body ?: "")
                    .setPositiveButton(android.R.string.yes) { _, _ ->
                        yes.set(true)
                        answered.countDown()
                    }
                    .setNegativeButton(android.R.string.no) { _, _ -> answered.countDown() }
                    .setOnCancelListener { _ -> answered.countDown() }
                    .create()
                dialogRef.set(dialog)
                dialog.show()
            } catch (_: Exception) {
                answered.countDown()
            }
        }

        val gotAnswer = try {
            answered.await(CONFIRM_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }

        if (!gotAnswer) {
            // Nobody answered in time. Dismiss on the main thread so the dialog
            // cannot outlive the question and be clicked into a latch nobody is
            // waiting on. Deferring the dismiss lets a click that was already
            // queued run first; `dismiss()` is idempotent and `answered` is
            // already released, so neither ordering double-counts or throws.
            main.post {
                try {
                    dialogRef.get()?.dismiss()
                } catch (_: Exception) {
                    // Already gone.
                }
            }
            diag?.log("CONFIRM answered=false timedOut=true")
            return false
        }
        val answer = yes.get()
        diag?.log("CONFIRM answered=$answer")
        answer
    }

    /**
     * Stand-in for `offMonitor`'s `scrnsave.scr /s`: dim *this window* to black
     * so the screen looks off during the performance.
     *
     * `screenBrightness = 0f` is a per-window override, so the device's own
     * brightness setting is never touched. Unlike the Windows screensaver, a
     * window attribute is *not* cleared by backgrounding, so [screenOff] also
     * arms a backstop and the activity calls [restoreScreenBrightness] on the
     * next user interaction and on pause/resume. See those two paths.
     */
    @JavascriptInterface
    fun screenOff() {
        tracked("screenOff") {
            // H4 evidence: if the log's last brightness line is `0` and no
            // restore follows, a "false black screen" is still on the table; if
            // brightness never drops, H4 is excluded outright.
            diag?.log("BRIGHTNESS 0 source=offMonitor")
            screenDimmed.set(true)
            main.post {
                // A restore (touch / pause) may have been queued before this ran and
                // already cancelled the dimming; honour that rather than re-dim.
                if (!screenDimmed.get()) return@post
                try {
                    val attributes = activity.window.attributes
                    attributes.screenBrightness = 0f
                    activity.window.attributes = attributes
                } catch (_: Exception) {
                    // A window that refuses the override is not worth failing the game for.
                }
            }
            // Safety net: the original ends on the next input, but a player who
            // never touches the screen must not be left staring at black forever.
            main.postDelayed({ restoreScreenBrightness() }, SCREEN_OFF_BACKSTOP_MS)
        }
    }

    /**
     * Drops the [screenOff] brightness override so the normal brightness
     * applies again. Idempotent and safe from any thread: the activity calls it
     * on user interaction and on pause/resume, and [screenOff] schedules it as
     * a backstop. A window that is already gone is ignored; a call when nothing
     * was dimmed does no work at all.
     */
    fun restoreScreenBrightness() {
        if (!screenDimmed.getAndSet(false)) return
        diag?.log("BRIGHTNESS none source=restore")
        main.post {
            try {
                val attributes = activity.window.attributes
                if (attributes.screenBrightness != WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE) {
                    attributes.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                    activity.window.attributes = attributes
                }
            } catch (_: Exception) {
                // The window has gone; nothing to restore.
            }
        }
    }

    /** Stand-in for `nircmd trayballoon`. */
    @JavascriptInterface
    fun toast(msg: String?) {
        tracked("toast") {
            val text = msg ?: return
            main.post {
                try {
                    Toast.makeText(activity, text, Toast.LENGTH_SHORT).show()
                } catch (_: Exception) {
                    // A toast that cannot be shown is not worth failing the game for.
                }
            }
        }
    }

    /**
     * Stand-in for `nircmd shutdown`: black the screen out, then close the app.
     *
     * The engine plays its own "正在关机" clip before it gets here; the black
     * overlay covers the WebView so the result is a genuine black screen.
     */
    @JavascriptInterface
    fun fakeShutdown() {
        tracked("fakeShutdown") {
            // An engine-initiated black screen would masquerade as the bug, so
            // the log must name it.
            diag?.log("SHUTDOWN overlay requested by the engine")
            main.post {
                try {
                    val overlay = View(activity).apply { setBackgroundColor(Color.BLACK) }
                    (activity.window.decorView as ViewGroup).addView(
                        overlay,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                } catch (_: Exception) {
                    // Without the overlay the app still exits below.
                }
                main.postDelayed({
                    try {
                        activity.finish()
                    } catch (_: Exception) {
                        // Already finishing.
                    }
                }, SHUTDOWN_BLACKOUT_MS)
            }
        }
    }

    /**
     * Stand-in for `nw.Shell.openItem()`.
     *
     * Hands another app a `content://` URI through androidx `FileProvider`, because on
     * API 24+ a `file://` URI sent to another app throws `FileUriExposedException` - so
     * the old `Uri.fromFile` version was dead on every API this app supports
     * (`minSdk 26`). The provider's paths are declared in `res/xml/file_paths.xml`.
     *
     * Still never throws: a path the provider refuses and a device with no viewer both
     * come back as `false`, which the contract allows and the engine reads as "could
     * not open".
     */
    @JavascriptInterface
    fun openFile(path: String?): Boolean = tracked("openFile") {
        val file = resolve(path) ?: return false
        try {
            if (!file.exists()) return false
            val uri = FileProvider.getUriForFile(activity, fileProviderAuthority(), file)
            activity.startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "*/*")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            )
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun fileProviderAuthority(): String = activity.packageName + FILE_PROVIDER_SUFFIX

    /** Vibration for the Meta performances (`navigator.vibrate` on platform 4). */
    @JavascriptInterface
    fun vibrate(ms: Long) {
        tracked("vibrate") {
            try {
                val vibrator = activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
                if (!vibrator.hasVibrator()) return
                vibrator.vibrate(
                    VibrationEffect.createOneShot(ms.coerceIn(1L, MAX_VIBRATION_MS), VibrationEffect.DEFAULT_AMPLITUDE)
                )
            } catch (_: Exception) {
                // Missing VIBRATE grant or a device without a vibrator.
            }
        }
    }

    @JavascriptInterface
    fun clipboardGet(): String = tracked("clipboardGet") {
        try {
            val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            val clip = manager?.primaryClip
            if (clip == null || clip.itemCount == 0) "" else clip.getItemAt(0).coerceToText(activity).toString()
        } catch (_: Exception) {
            ""
        }
    }

    @JavascriptInterface
    fun clipboardSet(s: String?) {
        tracked("clipboardSet") {
            val text = s ?: return
            main.post {
                try {
                    val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                    manager?.setPrimaryClip(ClipData.newPlainText(CLIP_LABEL, text))
                } catch (_: Exception) {
                    // Clipboard write refused; nothing to do.
                }
            }
        }
    }

    /**
     * The shim's `host.log` sink — and, during a diagnostic run, the single
     * funnel that puts every page-side line on disk. `Diag.log` is
     * line-flushed, so a `CALL` line written by the shim is durable before the
     * host call it precedes begins.
     */
    @JavascriptInterface
    fun log(s: String?) {
        tracked("log") {
            val text = s ?: ""
            // Ruling D: a failed asset probe means the page cannot reach its own
            // game files, which is the one failure that must not hide. Everything
            // else the engine logs is informational.
            if (text.startsWith(PROBE_FAILURE_PREFIX)) Log.e(TAG, text) else Log.d(TAG, text)
            diag?.log(text)
        }
    }

    /* ------------------------------------------------------------------ *
     * Internals
     * ------------------------------------------------------------------ */

    /**
     * The one place a `__GCNative` path becomes a file: game root first (POSIX
     * `resolve` relative to the working directory, matching the harness), then
     * the documents root. `null` means "refuse". Delegates to
     * [RootedPathAuthority], which is unit-tested.
     */
    private fun resolve(path: String?): File? = paths.resolveFile(path)

    /**
     * Mark [name] as the call in flight for the duration of [body], so the
     * main-thread watchdog can name a member the JS thread is parked inside.
     *
     * `tracked` is `inline`, so a `return` in a member body exits that member
     * directly and the `finally` below still clears the marker; the marker is
     * therefore never left set by a normal return. It is also the reason this
     * adds no allocation or exception surface of its own.
     */
    private inline fun <T> tracked(name: String, body: () -> T): T {
        inFlight.set("$name ${SystemClock.elapsedRealtime()}")
        try {
            return body()
        } finally {
            inFlight.set(null)
        }
    }

    /**
     * `"<member> <startRealtimeMs>"` for the member the JavaBridge thread is
     * currently inside, or `null`. Read from the main thread by the watchdog.
     */
    fun inFlightDescription(): String? = inFlight.get()

    /** Non-ASCII becomes `?`, exactly as the shim's own `asciiOnly` does. */
    private fun asciiOnly(value: String?): String {
        val text = value ?: return ""
        val out = StringBuilder(text.length)
        for (ch in text) out.append(if (ch.code < 0x80) ch else '?')
        return out.toString()
    }

    private companion object {
        const val TAG = "LoveNestBridge"
        const val CLIP_LABEL = "Love Nest"
        const val SHUTDOWN_BLACKOUT_MS = 1200L
        const val MAX_VIBRATION_MS = 10_000L

        /** How long a `confirm()` answer may take before it becomes "no". */
        const val CONFIRM_TIMEOUT_MS = 5 * 60 * 1000L

        /**
         * How long [screenOff] may keep the window black if no touch arrives.
         * The Windows screensaver ends on the next input; this is the safety
         * net that ends it anyway.
         */
        const val SCREEN_OFF_BACKSTOP_MS = 60 * 1000L

        /**
         * Prefix of the Ruling D asset-probe failure line emitted by
         * `MainActivity.BRIDGE_PROBE_JS`; see [log].
         */
        const val PROBE_FAILURE_PREFIX = "probe asset FAILED to load:"

        /** Matches `android:authorities="${applicationId}.fileprovider"` in the manifest. */
        const val FILE_PROVIDER_SUFFIX = ".fileprovider"
    }
}
