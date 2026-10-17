package com.wildstring.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
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
data class ServerConfiguration(val id: String, val url: String, val name: String = "", val allowLocalHttp: Boolean = false) {
    val label: String get() = name.ifBlank { url }
}

/** Persistent server identities and encrypted sessions; request owners change on every selection. */
@Singleton
class SessionStore @Inject constructor(@ApplicationContext context: Context) : CookieVault {
    private val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    private val gson = Gson()
    private val invalid = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val invalidations = invalid.asSharedFlow()
    private var generation = UUID.randomUUID().toString()
    private val profile = MutableStateFlow<String?>(null)
    val profiles = profile.asStateFlow()
    private val savedServers = MutableStateFlow<List<ServerConfiguration>>(emptyList())
    val servers = savedServers.asStateFlow()
    private val retained = MutableStateFlow<Set<String>>(emptySet())
    val retainedScopes = retained.asStateFlow()
    @Volatile private var validUntil = 0L
    val activeServerId: String? get() = prefs.getString("active_server", null)
    private fun field(name: String, id: String? = activeServerId) = "server:$id:$name"
    private fun records(): List<ServerConfiguration> = runCatching {
        gson.fromJson<List<ServerConfiguration>>(prefs.getString("servers_v1", "[]"), object : TypeToken<List<ServerConfiguration>>() {}.type)
    }.getOrNull().orEmpty()
    init {
        if (!prefs.contains("servers_v1")) {
            val oldUrl = prefs.getString("server", null)
            val id = UUID.randomUUID().toString()
            val edit = prefs.edit().putString("servers_v1", gson.toJson(if (oldUrl == null) emptyList() else listOf(ServerConfiguration(id, oldUrl, allowLocalHttp = prefs.getBoolean("local_http", false)))))
            if (oldUrl != null) {
                edit.putString("active_server", id)
                listOf("session_ciphertext", "cache_profile", "account").forEach { key -> prefs.getString(key, null)?.let { edit.putString(field(key, id), it) } }
            }
            // Commit the complete copy before removing legacy keys; no logout or encryption-key rotation.
            check(edit.commit())
            check(prefs.edit().remove("server").remove("local_http").remove("session_ciphertext").remove("cache_profile").remove("account").commit())
        }
        publish()
    }
    @Synchronized private fun publish() {
        savedServers.value = records()
        retained.value = records().mapNotNull { prefs.getString(field("cache_profile", it.id), null) }.toSet()
        profile.value = if (prefs.contains(field("session_ciphertext")) && prefs.contains(field("cache_profile"))) generation else null
    }
    @Synchronized fun <T> withStorageScope(expected: String?, action: (String) -> T): T? {
        if (expected == null || cacheScope() != expected) return null
        return prefs.getString(field("cache_profile"), null)?.let(action)
    }
    @Synchronized fun storageState(): Pair<String, String>? {
        val token = cacheScope() ?: return null
        return prefs.getString(field("cache_profile"), null)?.let { token to it }
    }
    /** Stable private-file owner; unlike cacheScope this survives leaving and returning to a server. */
    @Synchronized fun storageScope(): String? { cacheScope() ?: return null; return prefs.getString(field("cache_profile"), null) }
    @Synchronized fun retainedStorageScopes(): Set<String> = retained.value
    @Synchronized fun cacheScope(): String? {
        if (validUntil <= System.currentTimeMillis()) {
            val base = endpoint ?: return null
            val cookie = read()?.let { Cookie.parse(base, it) } ?: return null
            if (cookie.expiresAt <= System.currentTimeMillis()) { invalidate(); return null }
            validUntil = cookie.expiresAt
        }
        if (!prefs.contains(field("cache_profile"))) check(prefs.edit().putString(field("cache_profile"), UUID.randomUUID().toString()).commit())
        if (profile.value == null) publish(); return profile.value
    }
    val account: Account? get() = prefs.getString(field("account"), null)?.let { runCatching { gson.fromJson(it, Account::class.java) }.getOrNull() }
    fun accountFor(id: String): Account? = prefs.getString(field("account", id), null)?.let { runCatching { gson.fromJson(it, Account::class.java) }.getOrNull() }
    fun hasSession(id: String): Boolean = prefs.contains(field("session_ciphertext", id))
    @Synchronized fun bindAccount(account: Account?): Boolean {
        val changed = this.account?.id?.let { it != account?.id } == true
        val edit = prefs.edit()
        if (changed) { edit.putString(field("cache_profile"), UUID.randomUUID().toString()); generation = UUID.randomUUID().toString() }
        if (account == null) edit.remove(field("account")) else edit.putString(field("account"), gson.toJson(account))
        check(edit.commit()); publish(); return changed
    }
    val localHttp: Boolean get() = BuildConfig.DEBUG && records().firstOrNull { it.id == activeServerId }?.allowLocalHttp == true
    val endpoint: HttpUrl? get() = records().firstOrNull { it.id == activeServerId }?.let { runCatching { ServerAddress.normalize(it.url, localHttp) }.getOrNull() }
    @Synchronized fun saveServer(id: String?, raw: String, name: String, allowLocalHttp: Boolean): ServerConfiguration {
        val base = ServerAddress.normalize(raw, BuildConfig.DEBUG && allowLocalHttp).toString()
        val records = records()
        val existing = id?.let { key -> records.firstOrNull { it.id == key } ?: error("服务器配置不存在。") }
        require(records.none { it.url == base && it.id != id }) { "这个服务器已经保存，请直接选择。" }
        require(name.trim().length <= 80) { "服务器名称最多 80 个字符。" }
        val value = ServerConfiguration(existing?.id ?: UUID.randomUUID().toString(), base, name.trim(), BuildConfig.DEBUG && allowLocalHttp)
        val edit = prefs.edit().putString("servers_v1", gson.toJson(if (existing == null) records + value else records.map { if (it.id == id) value else it }))
        if (existing != null && existing.url != base) {
            listOf("session_ciphertext", "cache_profile", "account").forEach { edit.remove(field(it, existing.id)) }
            if (id == activeServerId) { validUntil = 0; generation = UUID.randomUUID().toString() }
        }
        check(edit.commit()); publish(); return value
    }
    @Synchronized fun selectServer(id: String) {
        require(records().any { it.id == id }) { "服务器配置不存在。" }
        if (id == activeServerId) return
        check(prefs.edit().putString("active_server", id).commit())
        generation = UUID.randomUUID().toString(); validUntil = 0; publish()
    }
    @Synchronized fun removeServer(id: String) {
        val edit = prefs.edit().putString("servers_v1", gson.toJson(records().filterNot { it.id == id }))
        listOf("session_ciphertext", "cache_profile", "account").forEach { edit.remove(field(it, id)) }
        if (activeServerId == id) { edit.remove("active_server"); generation = UUID.randomUUID().toString(); validUntil = 0 }
        check(edit.commit()); publish()
    }
    @Synchronized fun configure(raw: String, allowLocalHttp: Boolean) {
        val base = ServerAddress.normalize(raw, BuildConfig.DEBUG && allowLocalHttp).toString()
        val existing = records().firstOrNull { it.url == base }
        selectServer((existing ?: saveServer(null, raw, "", allowLocalHttp)).id)
    }
    @Synchronized fun requestState(): ServerRequestState? = endpoint?.let { ServerRequestState("$activeServerId:$generation", it) }
    @Synchronized fun isCurrent(state: ServerRequestState): Boolean = requestState()?.selection == state.selection
    @Synchronized fun cookieFor(state: ServerRequestState): String? = if (isCurrent(state)) read() else null
    @Synchronized fun cookieFrom(state: ServerRequestState, value: String?) {
        if (!isCurrent(state)) return
        val wasAuthenticated = profile.value != null
        write(value)
        if (value == null && wasAuthenticated) invalid.tryEmit(requestState()?.selection.orEmpty())
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
        val value = prefs.getString(field("session_ciphertext"), null) ?: return null
        return runCatching {
            val parts = value.split(":"); val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
        }.getOrElse { write(null); null }
    }
    @Synchronized override fun write(value: String?) {
        val edit = prefs.edit()
        if (value == null) {
            edit.remove(field("session_ciphertext")).remove(field("cache_profile")).remove(field("account"))
            generation = UUID.randomUUID().toString(); validUntil = 0
        } else {
            check(activeServerId != null) { "请先选择服务器。" }
            if (!prefs.contains(field("cache_profile"))) edit.putString(field("cache_profile"), UUID.randomUUID().toString())
            validUntil = endpoint?.let { Cookie.parse(it, value)?.expiresAt } ?: 0
            val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key())
            val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
            val data = Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
            edit.putString(field("session_ciphertext"), "$iv:$data")
        }
        check(edit.commit()); publish()
    }
    @Synchronized fun invalidate() { write(null); invalid.tryEmit(requestState()?.selection.orEmpty()) }
}

/** Kept as a small policy adapter for pure JVM consumers; production uses ScopedSessionInterceptor. */
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
        cookies.lastOrNull { it.name == "wildstring_session" && it.matches(url) }?.let { vault.write(if (it.expiresAt <= System.currentTimeMillis()) null else it.toString()) }
    }
}
