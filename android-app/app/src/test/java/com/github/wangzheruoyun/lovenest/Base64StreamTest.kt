package com.github.wangzheruoyun.lovenest

import java.io.File
import java.nio.file.Files
import java.util.Base64
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * The streaming encoder must be byte-identical to a one-shot base64 of the whole
 * file, at and around the chunk boundary (a classic off-by-one: the encoder
 * carries 1-2 leftover bytes between reads). If it is not, every image and save
 * the game writes through `writeBase64` would be silently corrupted.
 */
class Base64StreamTest {

    private lateinit var tmp: File

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("lovenest-base64").toFile()
    }

    @After
    fun tearDown() {
        tmp.deleteRecursively()
    }

    @Test
    fun round_trips_at_and_around_the_chunk_boundary() {
        val chunk = 3 * 16 * 1024
        for (size in listOf(0, 1, 2, 3, 4, chunk - 1, chunk, chunk + 1, chunk * 2 + 2, 100_000)) {
            val bytes = ByteArray(size) { (it * 31 + 7).toByte() }
            val file = File(tmp, "payload-$size.bin").apply { writeBytes(bytes) }

            val expected = Base64.getEncoder().encodeToString(bytes)
            val encoded = Base64Stream.encode(file)!!
            assertEquals("encode length $size", expected, encoded)
            assertArrayEquals("decode length $size", bytes, Base64Stream.decode(encoded))
        }
    }

    @Test
    fun encode_bytes_matches_the_one_shot_encoder() {
        val bytes = ByteArray(1000) { (it * 7).toByte() }
        assertEquals(Base64.getEncoder().encodeToString(bytes), Base64Stream.encode(bytes))
        assertEquals("", Base64Stream.encode(ByteArray(0)))
    }

    @Test
    fun encode_returns_null_for_a_missing_file() {
        assertNull(Base64Stream.encode(File(tmp, "nope.bin")))
    }

    @Test
    fun decode_accepts_wrapped_base64() {
        val bytes = ByteArray(10) { it.toByte() }
        val wrapped = Base64.getMimeEncoder(4, "\n".toByteArray()).encodeToString(bytes)
        assertArrayEquals(bytes, Base64Stream.decode(wrapped))
    }

    @Test
    fun decode_never_throws_on_malformed_input() {
        // Node's Buffer is lenient, so the shim may hand over something odd; the
        // one hard requirement is that it never escapes as an exception.
        Base64Stream.decode("")
        Base64Stream.decode("!!! not base64 at all !!!")
        Base64Stream.decode("QQ")
        Base64Stream.decode("=")
    }
}
