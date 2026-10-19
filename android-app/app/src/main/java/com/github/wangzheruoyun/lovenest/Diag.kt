package com.github.wangzheruoyun.lovenest

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Environment
import android.util.Log
import android.webkit.WebView
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The black-screen diagnostic log (Task 11): an append-only, line-flushed file
 * that is written from both the WebView's JavaBridge thread and the UI thread,
 * and that must be *trustworthy* — the whole point of the run is that the last
 * line on disk tells you where the game stopped.
 *
 * Three properties follow from that:
 *
 *  1. **A line that is buffered is a line you do not have.** Every write goes
 *     straight to a [FileOutputStream] and is flushed, so a line is in the
 *     kernel before the thing being observed is allowed to continue. This is
 *     what makes the shim's `CALL <name>` line (written *before* the host runs)
 *     able to expose a JS thread parked in a host call (H2).
 *  2. **Two threads, one writer.** [log] is `synchronized`, and it is called
 *     from the JavaBridge thread (`GameBridge.log`) and the main looper (the
 *     native watchdog, memory sampler and lifecycle hooks), so lines are never
 *     interleaved.
 *  3. **It must land somewhere the controller can read.** The preferred path is
 *     `/storage/emulated/0/Documents/爱之巢-logs/`, beside the game instead of
 *     inside it; when external storage is not writable the log falls back to
 *     the app's private `files/` directory and the header records which one was
 *     used. Nothing is ever written inside the game folder.
 *
 * The logger is instrumentation and nothing else: it never throws into a
 * caller, and it never changes game behaviour. When it cannot write at all it
 * degrades to logcat rather than failing a call.
 */
class Diag private constructor(
    private val file: File,

    /** True when [file] is on external storage; false for the private fallback. */
    val external: Boolean,
) {

    private val lock = Any()
    private var stream: FileOutputStream? = null
    private var written = 0L

    init {
        synchronized(lock) { openLocked() }
    }

    /** Absolute path of the live log file, for the header and the report. */
    fun path(): String = file.absolutePath

    /**
     * Append one line and make sure it reaches the OS before returning.
     *
     * A blank line still gets its newline, and a line carrying an embedded
     * newline is written as-is — the caller's framing is preserved.
     */
    fun log(line: String) {
        val bytes = (line + "\n").toByteArray(Charsets.UTF_8)
        synchronized(lock) {
            try {
                if (written + bytes.size > MAX_BYTES) rotateLocked()

                val out = stream
                if (out == null) {
                    // No file at all: keep the evidence in logcat instead.
                    Log.println(Log.WARN, TAG, line)
                    return
                }
                out.write(bytes)
                out.flush()
                written += bytes.size
            } catch (e: Exception) {
                Log.w(TAG, "diagnostic write failed for: $line", e)
            }
        }
    }

    /** Flush and release the file. Safe to call twice. */
    fun close() {
        synchronized(lock) { closeLocked() }
    }

    /* ------------------------------------------------------------------ *
     * Internals — callers must hold [lock]
     * ------------------------------------------------------------------ */

    private fun openLocked() {
        try {
            file.parentFile?.mkdirs()
            stream = FileOutputStream(file, true)
            written = file.length()
        } catch (e: Exception) {
            stream = null
            Log.w(TAG, "cannot open the diagnostic log at ${file.absolutePath}", e)
        }
    }

    private fun closeLocked() {
        try {
            stream?.flush()
        } catch (_: Exception) {
            // Nothing useful to do while shutting down.
        }
        try {
            stream?.close()
        } catch (_: Exception) {
            // Same.
        }
        stream = null
    }

    /**
     * Move the full file aside to `session-….log.1` and start a fresh one.
     * Called only when the next line would cross [MAX_BYTES].
     */
    private fun rotateLocked() {
        closeLocked()
        try {
            val rotated = File(file.parentFile, file.name + ".1")
            if (rotated.exists()) rotated.delete()
            file.renameTo(rotated)
        } catch (_: Exception) {
            // A rotation that fails just means the current file keeps growing.
        }
        written = 0L
        openLocked()
    }

    private fun writeHeader(context: Context, gameRoot: String, docsRoot: String, injection: String) {
        val metrics = context.resources.displayMetrics
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        // The WebView's own version matters on a black-screen hunt: a broken
        // renderer in a particular WebView build is a real possibility.
        val webViewPackage = try {
            WebView.getCurrentWebViewPackage()
        } catch (_: Exception) {
            null
        }
        val webView = if (webViewPackage == null) {
            "unknown"
        } else {
            "${webViewPackage.packageName}/${webViewPackage.versionName}"
        }

        log("DIAG start")
        log("HEADER wall=${wallClock()} epoch=${System.currentTimeMillis()}")
        log("HEADER package=${context.packageName}")
        log("HEADER webview=$webView")
        log("HEADER sdk=${Build.VERSION.SDK_INT} release=${Build.VERSION.RELEASE} model=${Build.MODEL} device=${Build.DEVICE}")
        log("HEADER screen=${metrics.widthPixels}x${metrics.heightPixels} density=${metrics.density} densityDpi=${metrics.densityDpi}")
        log("HEADER memoryClass=${activityManager?.memoryClass ?: -1} largeMemoryClass=${activityManager?.largeMemoryClass ?: -1}")
        log("HEADER gameRoot=$gameRoot docsRoot=$docsRoot")
        log("HEADER injection=$injection")
        log("HEADER logFile=${file.absolutePath} external=$external")
    }

    companion object {
        private const val TAG = "LoveNestDiag"

        /** The log folder beside the game — readable from a PC, never inside it. */
        const val LOG_DIR_NAME = "爱之巢-logs"

        /** Rotate to `….log.1` once the live file would pass this size. */
        private const val MAX_BYTES = 16L * 1024 * 1024

        private val STAMP_FORMAT = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
        private val WALL_FORMAT = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS Z", Locale.US)

        /**
         * Choose a directory and open `session-<yyyyMMdd-HHmmss>.log` inside it.
         *
         * External first (`Documents/爱之巢-logs`), the app's private `files/`
         * second. The header records the choice, so a controller reading a
         * private log still knows why it is where it is.
         */
        fun start(context: Context, gameRoot: String, docsRoot: String, injection: String): Diag {
            val stamp = STAMP_FORMAT.format(Date())
            val externalDir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
                LOG_DIR_NAME,
            )
            val privateDir = File(context.filesDir, LOG_DIR_NAME)
            val (dir, onExternal) = if (ensureDir(externalDir)) {
                externalDir to true
            } else {
                ensureDir(privateDir)
                privateDir to false
            }

            val diag = Diag(File(dir, "session-$stamp.log"), onExternal)
            diag.writeHeader(context, gameRoot, docsRoot, injection)
            return diag
        }

        private fun ensureDir(dir: File): Boolean = try {
            dir.isDirectory || dir.mkdirs()
        } catch (_: Exception) {
            false
        }

        private fun wallClock(): String = WALL_FORMAT.format(Date())
    }
}
