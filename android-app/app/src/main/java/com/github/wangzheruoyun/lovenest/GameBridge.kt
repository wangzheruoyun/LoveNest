package com.github.wangzheruoyun.lovenest

import android.app.Activity
import android.app.WallpaperManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.File
import org.json.JSONArray

/**
 * The native host behind `window.AndroidBridge`, which `MainActivity` aliases to
 * `window.__GCNative`.
 *
 * It implements the `__GCNative` contract name-for-name: the same 21 methods the
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
) {

    private val game = DirectFileSource(File(gameRoot))
    private val docs = DirectFileSource(File(docsRoot))
    private val main = Handler(Looper.getMainLooper())

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
    fun gameRoot(): String = game.root()

    /** Absolute documents root the engine treats as `os.homedir()`, no trailing slash. */
    @JavascriptInterface
    fun docsRoot(): String = docs.root()

    /* ------------------------------------------------------------------ *
     * Filesystem
     * ------------------------------------------------------------------ */

    @JavascriptInterface
    fun exists(path: String?): Boolean = resolve(path)?.exists() ?: false

    @JavascriptInterface
    fun stat(path: String?): String? {
        val file = resolve(path) ?: return null
        return try {
            if (!file.exists()) return null
            "{\"isDirectory\":${file.isDirectory},\"size\":${file.length()}}"
        } catch (_: Exception) {
            null
        }
    }

    @JavascriptInterface
    fun readBase64(path: String?): String? {
        val file = resolve(path) ?: return null
        if (!file.isFile) return null
        return Base64Stream.encode(file)
    }

    @JavascriptInterface
    fun writeBase64(path: String?, b64: String?): Boolean {
        val file = resolve(path) ?: return false
        val bytes = Base64Stream.decode(b64 ?: return false) ?: return false
        return try {
            file.parentFile?.mkdirs()
            file.outputStream().use { it.write(bytes) }
            true
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun readDir(path: String?): String {
        val entries = try {
            resolve(path)?.list()
        } catch (_: Exception) {
            null
        } ?: return "[]"
        return try {
            val array = JSONArray()
            for (entry in entries) array.put(entry as Any)
            array.toString()
        } catch (_: Exception) {
            "[]"
        }
    }

    @JavascriptInterface
    fun mkdirp(path: String?): Boolean {
        val file = resolve(path) ?: return false
        return try {
            file.isDirectory || file.mkdirs()
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun unlink(path: String?): Boolean {
        val file = resolve(path) ?: return false
        return try {
            // `File.delete()` happily removes an empty directory; Node's
            // unlinkSync refuses one with EISDIR, so refuse it here too.
            if (file.isDirectory) false else file.delete()
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun rename(path: String?, toPath: String?): Boolean {
        val from = resolve(path) ?: return false
        val to = resolve(toPath) ?: return false
        return try {
            from.renameTo(to)
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun rmdir(path: String?): Boolean {
        val file = resolve(path) ?: return false
        return try {
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
    fun deviceName(): String {
        val configured = try {
            Settings.Global.getString(activity.contentResolver, Settings.Global.DEVICE_NAME)
        } catch (_: Exception) {
            null
        }
        val name = configured?.takeIf { it.isNotBlank() } ?: (Build.MODEL ?: "")
        return asciiOnly(name)
    }

    /** `Android <release>`, ASCII-only, standing in for `wmic os get Caption`. */
    @JavascriptInterface
    fun androidVersion(): String = asciiOnly(Build.VERSION.RELEASE ?: "")

    /** Stand-in for `W26_DesktopWallpaper`: a real wallpaper change. */
    @JavascriptInterface
    fun setWallpaper(b64: String?): Boolean {
        val bytes = Base64Stream.decode(b64 ?: return false) ?: return false
        return try {
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return false
            WallpaperManager.getInstance(activity).setBitmap(bitmap)
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Stand-in for `nircmd trayballoon`. */
    @JavascriptInterface
    fun toast(msg: String?) {
        val text = msg ?: return
        main.post {
            try {
                Toast.makeText(activity, text, Toast.LENGTH_SHORT).show()
            } catch (_: Exception) {
                // A toast that cannot be shown is not worth failing the game for.
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

    /**
     * Stand-in for `nw.Shell.openItem()`.
     *
     * On API 24+ a `file://` URI may not be handed to another app, so without a
     * `FileProvider` (which would need androidx, and this module deliberately has
     * no dependencies) this usually reports `false` rather than crashing. The
     * contract allows a refusal, and the engine treats it as "could not open".
     */
    @JavascriptInterface
    fun openFile(path: String?): Boolean {
        val file = resolve(path) ?: return false
        return try {
            if (!file.exists()) return false
            activity.startActivity(
                Intent(Intent.ACTION_VIEW).setDataAndType(Uri.fromFile(file), "*/*")
            )
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Vibration for the Meta performances (`navigator.vibrate` on platform 4). */
    @JavascriptInterface
    fun vibrate(ms: Long) {
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

    @JavascriptInterface
    fun clipboardGet(): String = try {
        val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val clip = manager?.primaryClip
        if (clip == null || clip.itemCount == 0) "" else clip.getItemAt(0).coerceToText(activity).toString()
    } catch (_: Exception) {
        ""
    }

    @JavascriptInterface
    fun clipboardSet(s: String?) {
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

    @JavascriptInterface
    fun log(s: String?) {
        Log.d(TAG, s ?: "")
    }

    /* ------------------------------------------------------------------ *
     * Internals
     * ------------------------------------------------------------------ */

    /**
     * The one place a `__GCNative` path becomes a file: game root first (POSIX
     * `resolve` relative to the working directory, matching the harness), then
     * the documents root. `null` means "refuse".
     */
    private fun resolve(path: String?): File? {
        if (path.isNullOrEmpty()) return null
        game.resolve(path)?.let { return File(it) }
        docs.resolve(path)?.let { return File(it) }
        return null
    }

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
    }
}
