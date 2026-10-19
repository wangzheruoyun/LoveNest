package com.github.wangzheruoyun.lovenest

import android.net.Uri
import java.io.File

/**
 * The pure core of `script.js` interception (design §5.2): turn a request URL into
 * the exact engine file to serve, refusing anything that is not the game's own
 * `script.js`.
 *
 * Containment is delegated to [DirectFileSource.resolve] - the *same* authority
 * every `__GCNative` path goes through - so a percent-encoded `..` (`%2E%2E`) is
 * collapsed **before** the check instead of sailing past a raw
 * `startsWith("$gameRoot/")`. There is a single containment path, not two.
 *
 * `Uri.fromFile` percent-encodes the Chinese folder name, so decoding is
 * mandatory; [decode] is a parameter so unit tests can exercise this on the JVM
 * without the Android framework. Production uses `Uri.decode` (not `URLDecoder`,
 * which would turn `+` into a space).
 */
internal object ScriptRequest {

    const val FILE_NAME = "script.js"

    /**
     * The engine file [requestUrl] asks for, or `null` when it is not the game's
     * `script.js`. Never throws: a malformed percent-escape is simply a refusal.
     */
    fun fileFor(
        requestUrl: String?,
        gameRoot: String,
        decode: (String) -> String = { Uri.decode(it) },
    ): File? {
        val url = requestUrl ?: return null
        val withoutQuery = url.substringBefore('?').substringBefore('#')
        if (!withoutQuery.startsWith("file://")) return null

        val decoded = try {
            decode(withoutQuery).removePrefix("file://")
        } catch (_: Exception) {
            // A malformed escape (a trailing or invalid '%') is not a script request.
            return null
        }

        val resolved = DirectFileSource(File(gameRoot)).resolve(decoded) ?: return null
        if (!resolved.endsWith("/$FILE_NAME")) return null

        val file = File(resolved)
        return if (file.isFile) file else null
    }
}
