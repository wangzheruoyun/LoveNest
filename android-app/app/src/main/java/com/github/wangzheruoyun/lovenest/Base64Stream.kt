package com.github.wangzheruoyun.lovenest

import java.io.File
import java.io.FileInputStream
import java.util.Base64

/**
 * Base64 codec for the two binary members of the `__GCNative` contract
 * (`readBase64` / `writeBase64`).
 *
 * `Base64.getEncoder().encodeToString(file.readBytes())` would be one line, but
 * it holds the whole file *and* the whole encoded string in memory at once. The
 * asset tree contains files large enough for that to matter (a 9.5 MB script, a
 * 77 MB font), so [encode] streams instead: it reads the file in chunks whose
 * size is a multiple of three and encodes each chunk independently. That is
 * valid base64 because a three-byte-multiple chunk never emits `=` padding -
 * only the final partial chunk does.
 *
 * `java.util.Base64` (not `android.util.Base64`) is used deliberately so this
 * file stays pure JVM and can be round-trip tested in CI without an emulator.
 *
 * No method throws: a bad input or an unreadable file yields `null`.
 */
object Base64Stream {

    /** Multiple of three, so every full read encodes without padding. */
    private const val CHUNK_BYTES = 3 * 16 * 1024

    /** Cap on the pre-sized builder: ~64 M chars, enough to avoid most re-growth. */
    private const val MAX_HINT = 1 shl 26

    /** Base64 of [file]'s bytes (no line breaks, matching Node's `toString('base64')`). */
    fun encode(file: File): String? {
        var input: FileInputStream? = null
        return try {
            input = FileInputStream(file)
            val buffer = ByteArray(CHUNK_BYTES)
            val encoder = Base64.getEncoder()
            val hint = (file.length() / 3L * 4L).coerceAtMost(MAX_HINT.toLong()).toInt()
            val out = StringBuilder(if (hint > 0) hint else 16)
            val carry = ByteArray(3)
            var carryLength = 0

            while (true) {
                val read = input.read(buffer)
                if (read < 0) break

                var start = 0
                var length = read

                if (carryLength > 0) {
                    val needed = 3 - carryLength
                    if (length < needed) {
                        System.arraycopy(buffer, 0, carry, carryLength, length)
                        carryLength += length
                        continue
                    }
                    System.arraycopy(buffer, 0, carry, carryLength, needed)
                    out.append(encoder.encodeToString(carry))
                    start = needed
                    length -= needed
                    carryLength = 0
                }

                val wholeChunks = length - length % 3
                if (wholeChunks > 0) {
                    out.append(encoder.encodeToString(buffer.copyOfRange(start, start + wholeChunks)))
                }
                val remainder = length - wholeChunks
                if (remainder > 0) {
                    System.arraycopy(buffer, start + wholeChunks, carry, 0, remainder)
                    carryLength = remainder
                }
            }

            if (carryLength > 0) out.append(encoder.encodeToString(carry.copyOfRange(0, carryLength)))
            out.toString()
        } catch (_: Exception) {
            null
        } finally {
            try {
                input?.close()
            } catch (_: Exception) {
                // Nothing useful to do about a failed close.
            }
        }
    }

    /** Decode base64 [text], tolerating the whitespace Node-style output never has. */
    fun decode(text: String): ByteArray? = try {
        Base64.getMimeDecoder().decode(text)
    } catch (_: IllegalArgumentException) {
        null
    }
}
