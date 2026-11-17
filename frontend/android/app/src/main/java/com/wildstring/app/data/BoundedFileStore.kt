package com.wildstring.app.data

import java.io.File
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.MessageDigest

data class CachedBlob(val bytes: ByteArray, val writtenAt: Long)

/** App-private, bounded LRU files. One active store owns each directory; network IO stays outside its lock. */
class BoundedFileStore(private val directory: File, private val clock: () -> Long = System::currentTimeMillis) {
    private data class Entry(val file: File, val bytes: Long, val accessedAt: Long)
    private var entries: LinkedHashMap<String, Entry>? = null
    private var usedBytes = 0L

    // Rebuild once on opening a store, preserving persisted recency across process restarts.
    // Re-enumerating and stat-ing the directory on every put makes preparing N podcast episodes
    // depend on the size of the entire cache, even when nothing needs to be evicted.
    private fun index(): LinkedHashMap<String, Entry> = entries ?: linkedMapOf<String, Entry>().also { index ->
        usedBytes = 0
        directory.listFiles()?.filter { it.isFile }?.map { Entry(it, it.length(), it.lastModified()) }
            ?.sortedBy { it.accessedAt }?.forEach { entry ->
                index[entry.file.name] = entry
                usedBytes += entry.bytes
            }
        entries = index
    }
    private fun forget(index: MutableMap<String, Entry>, name: String) {
        index.remove(name)?.let { usedBytes -= it.bytes }
    }
    private fun remember(index: MutableMap<String, Entry>, entry: Entry) {
        forget(index, entry.file.name)
        index[entry.file.name] = entry
        usedBytes += entry.bytes
    }
    private fun file(key: String) = File(directory, MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) })
    @Synchronized fun read(key: String): CachedBlob? {
        val index = index()
        val path = file(key)
        return runCatching {
            if (!path.isFile) { forget(index, path.name); return null }
            if (path.length() !in 8..(2 * 1024 * 1024L + 8)) { path.delete(); forget(index, path.name); return null }
            val data = DataInputStream(path.inputStream()).use { input -> val time = input.readLong(); CachedBlob(input.readBytes(), time) }
            // Reading updates recency, independently of the stored freshness timestamp.
            val accessedAt = clock()
            check(path.setLastModified(accessedAt)) { "Cannot update cache recency" }
            remember(index, Entry(path, data.bytes.size + 8L, accessedAt))
            data
        }.getOrElse { path.delete(); forget(index, path.name); null }
    }
    @Synchronized fun put(key: String, bytes: ByteArray, maxBytes: Long) {
        if (maxBytes <= 0 || bytes.size + 8 > maxBytes) { trim(maxBytes); return }
        check(directory.isDirectory || directory.mkdirs()) { "Cannot create cache directory" }
        val index = index()
        val target = file(key)
        val temporary = File(directory, target.name + ".tmp")
        try {
            DataOutputStream(temporary.outputStream()).use { it.writeLong(clock()); it.write(bytes) }
            check(temporary.renameTo(target))
            val accessedAt = clock()
            check(target.setLastModified(accessedAt)) { "Cannot set cache recency" }
            remember(index, Entry(target, bytes.size + 8L, accessedAt))
        } catch (error: Exception) {
            // A failed filesystem operation may have replaced the target; reconcile on the next access.
            entries = null
            throw error
        } finally { temporary.delete() }
        trim(maxBytes)
    }
    @Synchronized fun trim(maxBytes: Long) {
        val iterator = index().entries.iterator()
        while (usedBytes > maxBytes.coerceAtLeast(0) && iterator.hasNext()) {
            val entry = iterator.next().value
            if (entry.file.delete() || !entry.file.exists()) {
                usedBytes -= entry.bytes
                iterator.remove()
            }
        }
    }
    @Synchronized fun clear() {
        directory.deleteRecursively()
        entries = null
    }
    @Synchronized fun size(): Long { index(); return usedBytes }
}
