package com.wildstring.app

import com.wildstring.app.data.BoundedFileStore
import java.io.File
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
    @Test fun podcastBatchDoesNotRescanTheDirectoryOnEveryWriteEvenAtCapacity() {
        val directory = object : File(temporary.newFolder().path) {
            var scans = 0
            override fun listFiles(): Array<File>? { scans++; return super.listFiles() }
        }
        val store = BoundedFileStore(directory) { time++ }
        // Two entries per episode, with a limit small enough to evict throughout the batch.
        repeat(50) { episode ->
            store.put("track:$episode", ByteArray(12), 80)
            store.put("podcast-episode:$episode", ByteArray(12), 80)
        }
        assertEquals(80L, store.size())
        assertEquals(1, directory.scans)
        assertNull(store.read("track:0"))
        assertNotNull(store.read("track:49"))
        assertNotNull(store.read("podcast-episode:49"))
        store.trim(40)
        assertEquals(40L, store.size())
        assertEquals(1, directory.scans)
    }

    @Test fun replacingEntriesUpdatesSizeAndRecencyWithoutDoubleCounting() {
        val store = BoundedFileStore(temporary.newFolder()) { time++ }
        store.put("a", ByteArray(12), 50)
        store.put("b", ByteArray(12), 50)
        store.put("a", ByteArray(2), 50)
        assertEquals(30L, store.size())
        store.put("c", ByteArray(20), 50)
        assertEquals(38L, store.size())
        assertNull(store.read("b"))
        assertEquals(2, store.read("a")!!.bytes.size)
        assertEquals(20, store.read("c")!!.bytes.size)
    }

    @Test fun reopeningReconstructsSizeAndLruOrderIncludingRecentReads() {
        val directory = temporary.newFolder()
        val original = BoundedFileStore(directory) { time++ }
        original.put("a", ByteArray(12), 40)
        original.put("b", ByteArray(12), 40)
        original.read("a")
        val reopened = BoundedFileStore(directory) { time++ }
        assertEquals(40L, reopened.size())
        reopened.put("c", ByteArray(12), 40)
        assertNull(reopened.read("b"))
        assertNotNull(reopened.read("a"))
        assertNotNull(reopened.read("c"))
        reopened.clear()
        assertEquals(0L, reopened.size())
        reopened.put("d", ByteArray(12), 40)
        assertEquals(20L, reopened.size())
    }

    @Test fun missingAndCorruptFilesAreRemovedFromTheInMemorySize() {
        val directory = temporary.newFolder()
        val store = BoundedFileStore(directory) { time++ }
        store.put("deleted", ByteArray(12), 40)
        directory.listFiles()!!.single().delete()
        assertNull(store.read("deleted"))
        assertEquals(0L, store.size())
        store.put("broken", ByteArray(12), 40)
        directory.listFiles()!!.single().writeBytes(byteArrayOf(1, 2))
        assertNull(store.read("broken"))
        assertEquals(0L, store.size())
    }

}
