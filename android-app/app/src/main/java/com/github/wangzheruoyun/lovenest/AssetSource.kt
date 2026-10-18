package com.github.wangzheruoyun.lovenest

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream

/**
 * Where asset bytes come from (design doc §5.5).
 *
 * Exactly the five members the plan's Task 7 Interfaces section specifies. The
 * only implementation shipped is [DirectFileSource] (a real path, which relies
 * on `MANAGE_EXTERNAL_STORAGE`); `SafSource` / `PrivateCopySource` are
 * deliberately *not* built - the human partner declined a SAF fallback - but
 * they can be dropped in behind this interface if a ROM ever refuses "all files
 * access".
 *
 * Everything is synchronous by design: the `__GCNative` contract is synchronous
 * (§5.4), so the shim's `fs` methods block on these calls.
 *
 * No member may ever throw: failures are reported as `null` / `false`.
 */
interface AssetSource {

    /** Open [path] for reading, or `null` if it does not exist / cannot be read. */
    fun open(path: String): InputStream?

    /** True when [path] exists. */
    fun exists(path: String): Boolean

    /** Entry names of the directory at [path], or `null` if it is not a readable directory. */
    fun list(path: String): List<String>?

    /** Write [bytes] to [path], creating missing parent directories. */
    fun write(path: String, bytes: ByteArray): Boolean

    /** Absolute root this source is confined to, with no trailing slash. */
    fun root(): String
}

/**
 * [AssetSource] over `java.io.File`, confined to one root directory.
 *
 * [resolve] is the single authority for path containment (plan Ruling 1): every
 * `__GCNative` method that touches a path goes through it, and anything that
 * escapes [root()] comes back as `null` rather than throwing.
 *
 * It is intentionally pure string work - no `File.canonicalPath`, no filesystem
 * access - so it behaves identically for paths that do not exist yet (the
 * engine stats and writes save files that are not there), and so it is cheap to
 * unit-test in CI. The normalisation mirrors `path.posix.resolve`, which is what
 * the headless host (`tools/headless/host-native.js`) uses, so device and
 * harness agree on what a path means.
 *
 * The root is deliberately *not* write-protected: Task 5 settled that the host
 * rejects only paths escaping the roots, and that adding a read-only rule for
 * the game tree would make the device diverge from the harness. The 740 MB
 * folder stays untouched because the engine derives save paths from
 * `os.homedir()` (i.e. the documents root), and because the headless contract
 * test asserts the game tree is byte-identical after a representative workload.
 */
class DirectFileSource(root: File) : AssetSource {

    private val normalizedRoot: String = normalizePosix(root.path)

    override fun root(): String = normalizedRoot

    /**
     * Resolve [path] to an absolute path under [root()], or `null` when it is
     * empty or escapes the root. Absolute inputs are normalised as-is; relative
     * inputs are resolved against the root (POSIX `resolve` semantics).
     */
    fun resolve(path: String): String? {
        if (path.isEmpty()) return null
        val absolute = if (path.startsWith('/')) {
            normalizePosix(path)
        } else {
            normalizePosix("$normalizedRoot/$path")
        }
        return if (isInside(normalizedRoot, absolute)) absolute else null
    }

    override fun open(path: String): InputStream? {
        val file = File(resolve(path) ?: return null)
        return try {
            if (file.isFile) FileInputStream(file) else null
        } catch (_: Exception) {
            null
        }
    }

    override fun exists(path: String): Boolean = try {
        File(resolve(path) ?: return false).exists()
    } catch (_: Exception) {
        false
    }

    override fun list(path: String): List<String>? = try {
        File(resolve(path) ?: return null).list()?.toList()
    } catch (_: Exception) {
        null
    }

    override fun write(path: String, bytes: ByteArray): Boolean = try {
        val file = File(resolve(path) ?: return false)
        file.parentFile?.mkdirs()
        FileOutputStream(file).use { it.write(bytes) }
        true
    } catch (_: Exception) {
        false
    }

    private companion object {

        /** True when [candidate] is [root] itself or lives underneath it. */
        fun isInside(root: String, candidate: String): Boolean {
            if (candidate == root) return true
            val prefix = if (root == "/") "/" else "$root/"
            return candidate.startsWith(prefix)
        }

        /** Lexical POSIX normalisation: collapse `.`, `..` and duplicate `/`. */
        fun normalizePosix(path: String): String {
            if (path.isEmpty()) return "."
            val absolute = path.startsWith('/')
            val segments = ArrayList<String>()
            for (segment in path.split('/')) {
                when (segment) {
                    "", "." -> Unit
                    ".." -> when {
                        segments.isNotEmpty() && segments.last() != ".." -> segments.removeAt(segments.size - 1)
                        !absolute -> segments.add("..")
                        else -> Unit
                    }
                    else -> segments.add(segment)
                }
            }
            val joined = segments.joinToString("/")
            return when {
                absolute -> "/$joined"
                joined.isEmpty() -> "."
                else -> joined
            }
        }
    }
}
