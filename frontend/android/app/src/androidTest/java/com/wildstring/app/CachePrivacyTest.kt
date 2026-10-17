package com.wildstring.app

import android.content.Context
import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.*
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

class CachePrivacyTest {
    @Test fun songListSizeSurvivesNewSettingsInstancesAndRejectsInvalidStorage() {
        val original = InstrumentationRegistry.getInstrumentation().targetContext
        val id = "list-size-${UUID.randomUUID()}"
        val context = object : ContextWrapper(original) {
            override fun getSharedPreferences(name: String, mode: Int) = original.getSharedPreferences("$id-$name", mode)
        }
        val prefs = context.getSharedPreferences("appearance_cache", Context.MODE_PRIVATE)
        try {
            val settings = AppSettings(context)
            assertEquals(SongListSize.MEDIUM, settings.state.value.songListSize)
            SongListSize.entries.forEach { size ->
                settings.songListSize(size)
                assertEquals(size, AppSettings(context).state.value.songListSize)
            }
            prefs.edit().putString("song_list_size", "unknown").commit()
            assertEquals(SongListSize.MEDIUM, AppSettings(context).state.value.songListSize)
            prefs.edit().putInt("song_list_size", 999).commit()
            assertEquals(SongListSize.MEDIUM, AppSettings(context).state.value.songListSize)
        } finally { prefs.edit().clear().commit() }
    }

    @Test fun cachesAreIsolatedAcrossLogoutLoginAndServerChanges() {
        val original = InstrumentationRegistry.getInstrumentation().targetContext
        val id = "cache-test-${UUID.randomUUID()}"
        val context = object : ContextWrapper(original) {
            override fun getCacheDir() = File(original.cacheDir, id).apply { mkdirs() }
            override fun getSharedPreferences(name: String, mode: Int) = original.getSharedPreferences("$id-$name", mode)
        }
        val session = SessionStore(context)
        val settings = AppSettings(context)
        settings.quality(192)
        assertEquals(192, AppSettings(context).state.value.aacBitrate)
        settings.quality(0)
        assertTrue(settings.state.value.haptics)
        settings.appearance("dark")
        assertEquals("dark", AppSettings(context).state.value.appearance)
        settings.haptics(false)
        assertFalse(AppSettings(context).state.value.haptics)
        val cache = ClientCache(context, session, settings)
        try {
            session.configure("http://127.0.0.1:1234/", true)
            assertNull(session.cacheScope())
            session.write("wildstring_session=first; Path=/; Max-Age=3600")
            val first = session.cacheScope()!!
            cache.put("catalog", "private".toByteArray(), first)
            cache.put("cover", byteArrayOf(1), first, true)
            assertEquals("private", String(cache.read("catalog")!!.bytes))
            cache.put("catalog:page", byteArrayOf(4), first)
            cache.put("lyrics:track", byteArrayOf(5), first)
            val revision = cache.catalogRevision
            cache.invalidateCatalog()
            assertNull(cache.read("catalog:page"))
            assertNotNull(cache.read("lyrics:track"))
            cache.put("catalog:late", byteArrayOf(6), first, revision = revision)
            assertNull(cache.read("catalog:late"))
            session.write("wildstring_session=refreshed; Path=/; Max-Age=3600")
            assertEquals("Cookie refresh must retain the cache owner", first, session.cacheScope())
            session.invalidate()
            assertNull(cache.read("catalog")); assertNull(cache.read("cover", true))
            session.write("wildstring_session=second; Path=/; Max-Age=3600")
            assertNotEquals(first, session.cacheScope())
            cache.put("stale", byteArrayOf(2), first)
            assertNull(cache.read("stale"))
            cache.put("catalog", byteArrayOf(3), session.cacheScope())
            session.configure("http://127.0.0.1:4321/", true)
            assertNull(cache.read("catalog"))
            assertEquals(0L to 0L, cache.usage())
        } finally { session.invalidate(); cache.clear(); context.cacheDir.deleteRecursively() }
    }
}
