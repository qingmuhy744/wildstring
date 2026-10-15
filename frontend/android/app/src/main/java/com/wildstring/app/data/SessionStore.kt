package com.wildstring.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dagger.hilt.android.qualifiers.ApplicationContext
import com.wildstring.app.BuildConfig
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

interface CookieVault { fun read(): String?; fun write(value: String?) }

@Singleton
class SessionStore @Inject constructor(@ApplicationContext context: Context) : CookieVault {
    private val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    private val invalid = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val invalidations = invalid.asSharedFlow()
    private val profile = MutableStateFlow(prefs.getString("cache_profile", null))
    val profiles = profile.asStateFlow()
    @Volatile private var validUntil = 0L
    @Synchronized fun cacheScope(): String? {
        if (validUntil <= System.currentTimeMillis()) {
            val base = endpoint ?: return null
            val cookie = read()?.let { Cookie.parse(base, it) } ?: return null
            if (cookie.expiresAt <= System.currentTimeMillis()) { invalidate(); return null }
            validUntil = cookie.expiresAt
        }
        if (profile.value == null) {
            val owner = UUID.randomUUID().toString()
            check(prefs.edit().putString("cache_profile", owner).commit())
            profile.value = owner
        }
        return profile.value
    }
    val account: Account? get() = prefs.getString("account", null)?.let { runCatching { com.google.gson.Gson().fromJson(it, Account::class.java) }.getOrNull() }
    @Synchronized fun bindAccount(account: Account?): Boolean {
        val changed = this.account?.id?.let { it != account?.id } == true
        val edit = prefs.edit()
        if (changed) {
            val owner = UUID.randomUUID().toString()
            edit.putString("cache_profile", owner); profile.value = owner
        }
        if (account == null) edit.remove("account") else edit.putString("account", com.google.gson.Gson().toJson(account))
        check(edit.commit())
        return changed
    }
    val localHttp: Boolean get() = BuildConfig.DEBUG && prefs.getBoolean("local_http", false)
    val endpoint: HttpUrl? get() = prefs.getString("server", null)?.let { runCatching { ServerAddress.normalize(it, localHttp) }.getOrNull() }
    @Synchronized fun configure(raw: String, allowLocalHttp: Boolean) {
        val base = ServerAddress.normalize(raw, BuildConfig.DEBUG && allowLocalHttp)
        if (base != endpoint) write(null)
        check(prefs.edit().putString("server", base.toString()).putBoolean("local_http", allowLocalHttp).commit())
    }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("wildstring_session", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("wildstring_session", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized override fun read(): String? {
        val value = prefs.getString("session_ciphertext", null) ?: return null
        return runCatching {
            val parts = value.split(":")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
        }.getOrElse { prefs.edit().remove("session_ciphertext").apply(); null }
    }
    @Synchronized override fun write(value: String?) {
        val edit = prefs.edit()
        if (value == null) {
            edit.remove("session_ciphertext").remove("cache_profile").remove("account")
            validUntil = 0
            profile.value = null
        } else {
            val owner = profile.value ?: UUID.randomUUID().toString()
            edit.putString("cache_profile", owner)
            profile.value = owner
            validUntil = endpoint?.let { Cookie.parse(it, value)?.expiresAt } ?: 0

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
            val data = Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
            edit.putString("session_ciphertext", "$iv:$data")
        }
        check(edit.commit())
    }
    fun invalidate() { write(null); invalid.tryEmit(Unit) }
}

class SessionCookieJar(private val vault: CookieVault, private val endpoint: () -> HttpUrl?) : CookieJar {
    @Synchronized override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val base = endpoint() ?: return emptyList()
        if (!ServerAddress.contains(base, url)) return emptyList()
        val cookie = vault.read()?.let { Cookie.parse(base, it) } ?: return emptyList()
        if (cookie.expiresAt <= System.currentTimeMillis()) { vault.write(null); return emptyList() }
        return listOf(cookie).filter { it.matches(url) }
    }
    @Synchronized override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val base = endpoint() ?: return
        if (!ServerAddress.contains(base, url)) return
        cookies.lastOrNull { it.name == "wildstring_session" && it.matches(url) }?.let {
            vault.write(if (it.expiresAt <= System.currentTimeMillis()) null else it.toString())
        }
    }
}
