package com.github.wangzheruoyun.lovenest

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Path mapping and the escape guard that all 21 `__GCNative` methods sit on.
 *
 * These run as plain JVM unit tests (no Android framework classes), so CI can
 * execute them with `gradle :app:testDebugUnitTest` and no emulator.
 *
 * The two first tests are the ones the plan's Step 1 gives verbatim.
 */
class PathMappingTest {

    private val gameRoot = "/storage/emulated/0/Download/爱之巢DemoV1.52"
    private lateinit var source: DirectFileSource
    private lateinit var tmp: File

    @Before
    fun setUp() {
        source = DirectFileSource(File(gameRoot))
        tmp = Files.createTempDirectory("lovenest-pathmapping").toFile()
    }

    @After
    fun tearDown() {
        tmp.deleteRecursively()
    }

    @Test
    fun relative_path_resolves_under_game_root() {
        assertEquals(
            "/storage/emulated/0/Download/爱之巢DemoV1.52/asset/a.png",
            source.resolve("asset/a.png")
        )
    }

    @Test
    fun dotdot_cannot_escape_game_root() {
        assertNull(source.resolve("../secret"))
    }

    @Test
    fun absolute_path_inside_root_is_kept() {
        assertEquals("$gameRoot/asset/a.png", source.resolve("$gameRoot/asset/a.png"))
    }

    @Test
    fun absolute_path_outside_root_is_rejected() {
        assertNull(source.resolve("/etc/passwd"))
        assertNull(source.resolve("/storage/emulated/0/Download"))
    }

    @Test
    fun sibling_directory_sharing_a_name_prefix_is_rejected() {
        // `love-nest-evil` startsWith the root, but is not *inside* it.
        assertNull(source.resolve("${gameRoot}_backup/save.json"))
        assertNull(source.resolve("/storage/emulated/0/Download/爱之巢DemoV1.52e/save.json"))
    }

    @Test
    fun nested_dotdot_that_stays_inside_root_is_allowed() {
        assertEquals("$gameRoot/config.json", source.resolve("asset/../config.json"))
    }

    @Test
    fun empty_path_is_rejected() {
        assertNull(source.resolve(""))
    }

    @Test
    fun trailing_slash_on_root_is_normalised() {
        assertEquals("$gameRoot/asset/a.png", DirectFileSource(File("$gameRoot/")).resolve("asset/a.png"))
    }

    @Test
    fun write_creates_missing_parent_directories() {
        val payload = byteArrayOf(0, 1, 2, 3, 127, -1, -128)
        val local = DirectFileSource(tmp)

        assertFalse(local.exists("saves/slot1.bin"))
        assertTrue(local.write("saves/slot1.bin", payload))
        assertTrue(local.exists("saves/slot1.bin"))

        val readBack = local.open("saves/slot1.bin")!!.use { it.readBytes() }
        assertArrayEquals(payload, readBack)
    }

    @Test
    fun list_returns_entries_and_null_when_missing() {
        val local = DirectFileSource(tmp)
        assertNull(local.list("nope"))
        local.write("a/one.txt", byteArrayOf(1))
        local.write("a/two.txt", byteArrayOf(2))
        assertEquals(listOf("one.txt", "two.txt"), local.list("a")?.sorted())
    }

    @Test
    fun open_refuses_paths_that_escape_the_root() {
        val local = DirectFileSource(tmp)
        assertNull(local.open("../outside.txt"))
    }
}
