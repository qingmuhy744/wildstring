package com.wildstring.app

import android.content.Context
import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.Account
import com.wildstring.app.data.SessionStore
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

class AccountPrivacyTest {
    @Test fun legacyProfilesAreEncryptedAcrossServersWithoutLosingTheSession() {
        val original = InstrumentationRegistry.getInstrumentation().targetContext
        val testId = "account-privacy-${UUID.randomUUID()}"
        val context = object : ContextWrapper(original) {
            override fun getSharedPreferences(name: String, mode: Int) = original.getSharedPreferences("$testId-$name", mode)
        }
        val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
        try {
            val session = SessionStore(context)
            session.configure("https://first.example/", false)
            val first = session.activeServerId!!
            session.write("wildstring_session=synthetic-session; Path=/; Max-Age=3600; Secure")
            val cookie = session.read()
            assertNotNull(cookie)
            val second = session.saveServer(null, "https://second.example/", "Second", false).id
            // Fixed synthetic profiles reproduce the storage layout of earlier versions.
            check(prefs.edit()
                .putString("server:$first:account", """{"id":"fixture-first","username":"fixture-user-one","profile":"owner","enabled":true,"version":7}""")
                .putString("server:$second:account", """{"id":"fixture-second","username":"fixture-user-two","profile":"listener","enabled":true,"version":3}""")
                .commit())
            val restored = SessionStore(context)
            assertEquals(cookie, restored.read())
            assertEquals(Account("fixture-first", "fixture-user-one", "owner", true, 7), restored.account)
            assertEquals(Account("fixture-second", "fixture-user-two", "listener", true, 3), restored.accountFor(second))
            assertFalse(prefs.contains("server:$first:account"))
            assertFalse(prefs.contains("server:$second:account"))
            assertFalse(prefs.all.values.any { it.toString().contains("fixture-user") })

            restored.bindAccount(Account("fixture-first", "fixture-user-renamed", "owner"))
            assertEquals("fixture-user-renamed", SessionStore(context).account!!.username)
            assertFalse(prefs.all.values.any { it.toString().contains("fixture-user") })
            restored.removeServer(second)
            assertFalse(prefs.contains("server:$second:account_ciphertext"))

            check(prefs.edit().putString("server:$first:account_ciphertext", "invalid-ciphertext").commit())
            assertNull(restored.account)
            assertEquals(cookie, restored.read())
            restored.invalidate()
            assertFalse(prefs.contains("server:$first:account_ciphertext"))
        } finally { check(prefs.edit().clear().commit()) }
    }
}
