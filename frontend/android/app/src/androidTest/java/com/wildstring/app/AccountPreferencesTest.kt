package com.wildstring.app

import android.content.Context
import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.AccountPreferences
import com.wildstring.app.data.AppSettings
import com.wildstring.app.data.CatalogSort
import com.wildstring.app.data.SongListSize
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

class AccountPreferencesTest {
    private fun isolated(action: (Context) -> Unit) {
        val original = InstrumentationRegistry.getInstrumentation().targetContext
        val prefix = "preferences-${UUID.randomUUID()}-"
        val names = mutableSetOf<String>()
        val context = object : ContextWrapper(original) {
            override fun getSharedPreferences(name: String, mode: Int) = original.getSharedPreferences("$prefix$name".also { names.add(it) }, mode)
        }
        try { action(context) } finally { names.forEach(original::deleteSharedPreferences) }
    }

    @Test fun preferencesMigrateOnceAndRestoreAcrossAccountsServersAndRestarts() = isolated { context ->
        val legacy = context.getSharedPreferences("appearance_cache", Context.MODE_PRIVATE)
        legacy.edit().putString("appearance", "dark").putInt("aac_bitrate", 192).putBoolean("red_icon", true).commit()
        val settings = AppSettings(context)
        settings.bindAccount("server-a", "account-a")
        assertEquals("dark", settings.state.value.appearance)
        assertEquals(192, settings.state.value.aacBitrate)
        settings.songListSize(SongListSize.LARGE)
        settings.catalogSort("old-login", "tracks", CatalogSort("duration_ms", "desc"))
        settings.bindAccount("server-a", "account-b")
        assertEquals("system", settings.state.value.appearance)
        assertEquals(0, settings.state.value.aacBitrate)
        assertEquals(SongListSize.MEDIUM, settings.state.value.songListSize)
        assertEquals(CatalogSort("title", "asc"), settings.catalogSort("other-login", "tracks"))
        assertTrue(settings.state.value.redIcon) // One launcher icon belongs to the installed app.
        settings.quality(320); settings.appearance("light")
        settings.bindAccount("server-b", "account-a")
        assertEquals(0, settings.state.value.aacBitrate)
        settings.bindAccount("server-a", "account-a")
        assertEquals(192, settings.state.value.aacBitrate)
        assertEquals(SongListSize.LARGE, settings.state.value.songListSize)
        assertEquals(CatalogSort("duration_ms", "desc"), settings.catalogSort("new-login", "tracks"))
        settings.bindAccount(null, null)
        assertEquals(0, settings.state.value.aacBitrate)
        val reopened = AppSettings(context)
        reopened.bindAccount("server-a", "account-b")
        assertEquals(320, reopened.state.value.aacBitrate)
        assertEquals("light", reopened.state.value.appearance)
    }

    @Test fun networkAndDownloadOptionsAreIsolatedAndKeepLegacyValuesForOneAccount() = isolated { context ->
        val name = "offline-options"
        val keys = setOf("wifi_only", "download_bitrate", "capacity_gb")
        context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().putBoolean("wifi_only", false).putInt("download_bitrate", 192).commit()
        val first = AccountPreferences.forAccount(context, name, "s", "a", keys)
        assertFalse(first.getBoolean("wifi_only", true))
        assertEquals(192, first.getInt("download_bitrate", 0))
        val other = AccountPreferences.forAccount(context, name, "s", "b", keys)
        assertTrue(other.getBoolean("wifi_only", true))
        assertEquals(0, other.getInt("download_bitrate", 0))
        other.edit().putInt("download_bitrate", 320).commit()
        assertEquals(192, AccountPreferences.forAccount(context, name, "s", "a", keys).getInt("download_bitrate", 0))
        assertEquals(320, AccountPreferences.forAccount(context, name, "s", "b", keys).getInt("download_bitrate", 0))
    }
}
