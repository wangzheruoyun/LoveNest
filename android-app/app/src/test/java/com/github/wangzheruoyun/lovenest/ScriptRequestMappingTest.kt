package com.github.wangzheruoyun.lovenest

import java.io.File
import java.net.URI
import java.net.URLEncoder
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * The `script.js` request -> file mapping that decides whether the shim is served
 * (design §5.2).
 *
 * The trap this guards: the request URL is percent-encoded (the game folder name is
 * Chinese), so a containment check on the *decoded* path must normalise first - a
 * `%2E%2E` decodes to `..` and a raw `startsWith("$gameRoot/")` would let it through.
 *
 * `ScriptRequest` is the pure core of `MainActivity.interceptScript`; `decode` is
 * injected so this runs on the JVM without the Android framework (production passes
 * `android.net.Uri.decode`).
 */
class ScriptRequestMappingTest {

    private lateinit var tmp: File
    private lateinit var gameRoot: File

    /** Stands in for `android.net.Uri.decode` (which, unlike `URLDecoder`, leaves `+`). */
    private val decode: (String) -> String = { URI(it).path }

    /** Mimics `Uri.fromFile(...).toString()`: percent-encode non-ASCII and spaces. */
    private fun fileUrl(file: File): String {
        val encoded = file.absolutePath.split('/').joinToString("/") { segment ->
            URLEncoder.encode(segment, "UTF-8").replace("+", "%20")
        }
        return "file://$encoded"
    }

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("lovenest-script").toFile()
        gameRoot = File(tmp, "爱之巢DemoV1.52").apply { mkdirs() }
        File(gameRoot, "script.js").writeText("// engine")
    }

    @After
    fun tearDown() {
        tmp.deleteRecursively()
    }

    @Test
    fun resolves_the_engines_own_script_under_the_game_root() {
        val url = fileUrl(File(gameRoot, "script.js")) + "?r=1736932678789"
        assertEquals(File(gameRoot, "script.js"), ScriptRequest.fileFor(url, gameRoot.absolutePath, decode))
    }

    @Test
    fun percent_encoded_dotdot_cannot_escape_the_game_root() {
        val sibling = File(tmp, "outside").apply { mkdirs() }
        File(sibling, "script.js").writeText("// not the engine")
        val escaped = fileUrl(gameRoot) + "/%2E%2E/outside/script.js"
        assertNull(ScriptRequest.fileFor(escaped, gameRoot.absolutePath, decode))
    }

    @Test
    fun a_sibling_directory_sharing_the_name_prefix_is_refused() {
        val sibling = File(tmp, "爱之巢DemoV1.52e").apply { mkdirs() }
        File(sibling, "script.js").writeText("// not the engine")
        assertNull(ScriptRequest.fileFor(fileUrl(File(sibling, "script.js")), gameRoot.absolutePath, decode))
    }

    @Test
    fun a_request_that_is_not_script_js_is_refused() {
        assertNull(ScriptRequest.fileFor(fileUrl(File(gameRoot, "index.html")), gameRoot.absolutePath, decode))
    }

    @Test
    fun a_malformed_escape_never_throws() {
        assertNull(ScriptRequest.fileFor("file:///tmp/%zz/script.js", gameRoot.absolutePath, decode))
    }

    @Test
    fun a_non_file_request_is_refused() {
        assertNull(ScriptRequest.fileFor("https://example.com/script.js", gameRoot.absolutePath, decode))
    }

    @Test
    fun a_null_request_is_refused() {
        assertNull(ScriptRequest.fileFor(null, gameRoot.absolutePath, decode))
    }
}
