package com.github.wangzheruoyun.lovenest

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The composed path resolution `GameBridge` performs for every `__GCNative` call:
 * try the game root, then the documents root, through [DirectFileSource.resolve].
 *
 * This composition - and therefore *where saves land* - used to live inside
 * `GameBridge`, which needs an `Activity`; it is extracted into
 * [RootedPathAuthority] so the save placement is guarded in CI.
 */
class ComposedResolutionTest {

    private val gameRoot = "/storage/emulated/0/Download/爱之巢DemoV1.52"
    private val docsRoot = "/storage/emulated/0/Documents/爱之巢DemoV1.52"

    private val authority = RootedPathAuthority(
        DirectFileSource(File(gameRoot)),
        DirectFileSource(File(docsRoot)),
    )

    @Test
    fun a_game_relative_path_lands_under_the_game_root() {
        assertEquals("$gameRoot/asset/a.png", authority.resolve("asset/a.png"))
    }

    @Test
    fun an_absolute_save_path_lands_under_the_docs_root_unchanged() {
        // The engine's own save path: path.join(os.homedir(), 'Documents', gameName, dirname).
        val save = "$docsRoot/Documents/爱之巢DemoV1.52/save/1.json"
        assertEquals(save, authority.resolve(save))
        assertEquals(save, authority.resolveFile(save)?.path)
    }

    @Test
    fun the_final_save_path_reproduces_the_engines_join() {
        val gameName = "爱之巢DemoV1.52"
        val dirname = "save"
        val userFolder = listOf(docsRoot, "Documents", gameName, dirname).joinToString("/")
        assertEquals("$docsRoot/Documents/$gameName/$dirname/1.json", authority.resolve("$userFolder/1.json"))
    }

    @Test
    fun a_dotdot_save_path_cannot_escape_either_root() {
        assertNull(authority.resolve("Documents/../../../../etc/passwd"))
    }

    @Test
    fun a_path_under_neither_root_is_refused() {
        assertNull(authority.resolve("/etc/passwd"))
        assertNull(authority.resolve("/storage/emulated/0/Download"))
        assertNull(authority.resolve(""))
        assertNull(authority.resolve(null))
    }

    @Test
    fun the_game_root_is_tried_before_the_docs_root() {
        assertEquals("$gameRoot/Documents/x.json", authority.resolve("Documents/x.json"))
    }
}
