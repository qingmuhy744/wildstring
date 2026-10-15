package com.wildstring.app

import com.wildstring.app.data.BoundedFileStore
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class BoundedFileStoreTest {
    @get:Rule val temporary = TemporaryFolder()
    private var time = 1_000L
    @Test fun lruEvictionHonorsReadsAndEnvelopeSize() {
        val store = BoundedFileStore(temporary.newFolder()) { time++ }
        store.put("a", ByteArray(12), 40); store.put("b", ByteArray(12), 40)
        assertNotNull(store.read("a"))
        store.put("c", ByteArray(12), 40)
        assertNull(store.read("b")); assertNotNull(store.read("a")); assertNotNull(store.read("c")); assertEquals(40L, store.size())
    }
    @Test fun readDoesNotExtendFreshnessAndSurvivesRestart() {
        val directory = temporary.newFolder()
        val store = BoundedFileStore(directory) { time++ }
        store.put("song", "lyrics".toByteArray(), 100)
        val first = store.read("song")!!
        time += 1000
        val restored = BoundedFileStore(directory) { time++ }.read("song")!!
        assertEquals(first.writtenAt, restored.writtenAt); assertArrayEquals(first.bytes, restored.bytes)
    }
    @Test fun reducingLimitAndDisablingImmediatelyEvictsFiles() {
        val store = BoundedFileStore(temporary.newFolder()) { time++ }
        store.put("a", ByteArray(12), 40); store.put("b", ByteArray(12), 40)
        store.trim(20); assertEquals(20L, store.size()); assertNull(store.read("a"))
        store.trim(0); assertEquals(0L, store.size()); assertNull(store.read("b"))
    }
    @Test fun oversizedEntriesAndPartialFilesCannotBecomeCacheHits() {
        val directory = temporary.newFolder()
        val store = BoundedFileStore(directory)
        store.put("huge", ByteArray(101), 100); assertNull(store.read("huge"))
        store.put("broken", ByteArray(10), 100)
        directory.listFiles()!!.single().writeBytes(byteArrayOf(1, 2))
        assertNull(store.read("broken")); assertEquals(0L, store.size())
    }
}
