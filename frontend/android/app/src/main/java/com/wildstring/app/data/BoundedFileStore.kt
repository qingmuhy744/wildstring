package com.wildstring.app.data

import java.io.File
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.MessageDigest

data class CachedBlob(val bytes: ByteArray, val writtenAt: Long)

/** App-private, bounded LRU files. Network requests never run while holding this lock. */
class BoundedFileStore(private val directory: File, private val clock: () -> Long = System::currentTimeMillis) {
    private fun file(key: String) = File(directory, MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) })
    @Synchronized fun read(key: String): CachedBlob? {
        val path = file(key)
        return runCatching {
            if (!path.isFile) return null
            if (path.length() !in 8..(2 * 1024 * 1024L + 8)) { path.delete(); return null }
            val data = DataInputStream(path.inputStream()).use { input -> val time = input.readLong(); CachedBlob(input.readBytes(), time) }
            // Reading also updates recency, independently of the stored freshness timestamp.
            path.setLastModified(clock())
            data
        }.getOrElse { path.delete(); null }
    }
    @Synchronized fun put(key: String, bytes: ByteArray, maxBytes: Long) {
        if (maxBytes <= 0 || bytes.size + 8 > maxBytes) { trim(maxBytes); return }
        directory.mkdirs()
        val target = file(key)
        val temporary = File(directory, target.name + ".tmp")
        try {
            DataOutputStream(temporary.outputStream()).use { it.writeLong(clock()); it.write(bytes) }
            check(temporary.renameTo(target))
            target.setLastModified(clock())
        } finally { temporary.delete() }
        trim(maxBytes)
    }
    @Synchronized fun trim(maxBytes: Long) {
        val files = directory.listFiles()?.filter { it.isFile }?.sortedBy { it.lastModified() }.orEmpty()
        var used = files.sumOf { it.length() }
        for (file in files) { if (used <= maxBytes.coerceAtLeast(0)) break; val size = file.length(); if (file.delete()) used -= size }
    }
    @Synchronized fun clear() { directory.deleteRecursively() }
    @Synchronized fun size(): Long = directory.listFiles()?.sumOf { it.length() } ?: 0
}
