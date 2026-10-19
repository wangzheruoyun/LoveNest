package com.github.wangzheruoyun.lovenest

import java.io.File

/**
 * The composition `GameBridge` uses to turn a `__GCNative` path into a real file:
 * try each root in order (the game root first, then the documents root) through
 * [DirectFileSource.resolve], the single containment authority.
 *
 * Extracted out of `GameBridge`, which needs an `Activity`, so the decision that
 * places the engine's saves is guarded by a plain JVM unit test - losing saves is
 * a core failure this port must not have.
 */
internal class RootedPathAuthority(private val roots: List<DirectFileSource>) {

    constructor(vararg roots: DirectFileSource) : this(roots.toList())

    /** Normalised absolute path under one of the roots, or `null` to refuse. */
    fun resolve(path: String?): String? {
        if (path.isNullOrEmpty()) return null
        for (root in roots) {
            root.resolve(path)?.let { return it }
        }
        return null
    }

    fun resolveFile(path: String?): File? = resolve(path)?.let { File(it) }
}
