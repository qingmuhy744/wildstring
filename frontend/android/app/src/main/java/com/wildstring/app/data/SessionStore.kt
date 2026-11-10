package com.wildstring.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import dagger.hilt.android.qualifiers.ApplicationContext
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
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

data class ServerRoute(val name: String, val url: String, val allowHttp: Boolean)

interface CookieVault { fun read(): String?; fun write(value: String?) }
data class ServerConfiguration(val id: String, val url: String, val name: String = "", val allowLocalHttp: Boolean = false, val serverName: String? = null, val instanceId: String? = null) {
    val label: String get() = name.ifBlank { serverName?.takeIf { it.isNotBlank() } ?: url }
}

/** Persistent server identities and encrypted sessions; request owners change on every selection. */
@Singleton
class SessionStore @Inject constructor(@ApplicationContext context: Context) : CookieVault, ServerRouteSessions {
    private val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    private val gson = Gson()
    private val invalid = MutableSharedFlow<String>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val invalidations = invalid.asSharedFlow()
    private var generation = UUID.randomUUID().toString()
    private val profile = MutableStateFlow<String?>(null)
    val profiles = profile.asStateFlow()
    private val savedServers = MutableStateFlow<List<ServerConfiguration>>(emptyList())
    override val servers = savedServers.asStateFlow()
    private val savedRoutes = MutableStateFlow<List<ServerRoute>>(emptyList())
    val routes = savedRoutes.asStateFlow()
    private val retained = MutableStateFlow<Set<String>>(emptySet())
    val retainedScopes = retained.asStateFlow()
    @Volatile private var validUntil = 0L
    override val activeServerId: String? get() = prefs.getString("active_server", null)
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
        // Migrate every retained server atomically before exposing account profiles.
        val accounts = prefs.edit()
        records().forEach { server ->
            prefs.getString(field("account", server.id), null)?.let { legacy ->
                accounts.putString(field("account_ciphertext", server.id), encrypt(legacy))
                    .remove(field("account", server.id))
            }
        }
        check(accounts.commit())
        publish()
    }
    @Synchronized private fun publish() {
        savedServers.value = records()
        savedRoutes.value = routeRecords()
        retained.value = records().mapNotNull { prefs.getString(field("cache_profile", it.id), null) }.toSet()
        profile.value = if (prefs.contains(cookieField()) && prefs.contains(field("cache_profile"))) generation else null
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
    private fun readAccount(id: String?): Account? = prefs.getString(field("account_ciphertext", id), null)?.let {
        runCatching { gson.fromJson(decrypt(it), Account::class.java) }.getOrNull()
    }
    override val account: Account? get() = readAccount(activeServerId)
    fun accountFor(id: String): Account? = readAccount(id)
    fun hasSession(id: String): Boolean = prefs.contains(cookieField(id))
    @Synchronized fun bindAccount(account: Account?): Boolean {
        val changed = this.account?.id?.let { it != account?.id } == true
        val edit = prefs.edit()
        if (changed) { edit.putString(field("cache_profile"), UUID.randomUUID().toString()); generation = UUID.randomUUID().toString() }
        edit.remove(field("account"))
        if (account == null) edit.remove(field("account_ciphertext"))
        else edit.putString(field("account_ciphertext"), encrypt(gson.toJson(account)))
        check(edit.commit()); publish(); return changed
    }
    /** Explicit per-server consent for cleartext HTTP; retained name keeps old preferences compatible. */
    val localHttp: Boolean get() = routeRecords().firstOrNull { it.url == activeRouteUrl }?.allowHttp == true
    override val activeRouteUrl: String? get() = prefs.getString(field("active_route"), null) ?: records().firstOrNull { it.id == activeServerId }?.url
    override val manualRoute: String? get() = prefs.getString(field("manual_route"), null)
    val endpoint: HttpUrl? get() = activeRouteUrl?.let { runCatching { ServerAddress.normalize(it, localHttp) }.getOrNull() }
    override fun routeRecords(): List<ServerRoute> = routesFor(activeServerId)
    private fun routesFor(id: String?): List<ServerRoute> {
        val server = records().firstOrNull { it.id == id } ?: return emptyList()
        val stored = prefs.getString(field("routes", id), null)
        return if (stored == null) listOf(ServerRoute(AppLanguage.string(R.string.sess_store_default_route_name), server.url, server.allowLocalHttp)) else
            gson.fromJson(stored, object : TypeToken<List<ServerRoute>>() {}.type)
    }
    private fun cookieField(id: String? = activeServerId, url: String? = null): String {
        val primary = records().firstOrNull { it.id == id }?.url
        val route = url ?: prefs.getString(field("active_route", id), null) ?: primary
        return if (route == primary) field("session_ciphertext", id) else field("route_cookie:$route", id)
    }
    @Synchronized override fun routeCookie(url: String): String? = prefs.getString(cookieField(url = url), null)?.let(::decrypt)
    @Synchronized override fun saveRoute(route: ServerRoute, cookie: String) {
        val previous = routeRecords()
        val routes = if (previous.any { it.url == route.url }) previous.map { if (it.url == route.url) route else it } else previous + route
        check(prefs.edit().putString(field("routes"), gson.toJson(routes)).putString(cookieField(url = route.url), encrypt(cookie)).commit()); publish()
    }
    @Synchronized fun editRoutes(routes: List<ServerRoute>) {
        require(routes.isNotEmpty() && routes.any { it.url == activeRouteUrl })
        val removed = routeRecords().filter { old -> routes.none { it.url == old.url } }
        val edit = prefs.edit().putString(field("routes"), gson.toJson(routes))
        removed.forEach { edit.remove(cookieField(url = it.url)) }
        check(edit.commit()); publish()
    }
    @Synchronized override fun setRouteMode(address: String?) { check(prefs.edit().putString(field("manual_route"), address).commit()); publish() }
    @Synchronized override fun selectRoute(route: ServerRoute) {
        require(routeRecords().any { it == route })
        check(prefs.edit().putString(field("active_route"), route.url).commit())
        validUntil = 0; publish()
    }
    @Synchronized fun clearRouteSessions() {
        val edit = prefs.edit()
        routeRecords().forEach { edit.remove(cookieField(url = it.url)) }
        check(edit.commit()); write(null)
    }
    @Synchronized fun saveServer(id: String?, raw: String, name: String, allowLocalHttp: Boolean): ServerConfiguration {
        val base = ServerAddress.normalize(raw, allowLocalHttp).toString()
        val records = records()
        val existing = id?.let { key -> records.firstOrNull { it.id == key } ?: error(AppLanguage.string(R.string.sess_store_server_not_found)) }
        require(records.none { it.url == base && it.id != id }) { AppLanguage.string(R.string.sess_store_server_already_exists) }
        require(name.trim().length <= 80) { AppLanguage.string(R.string.sess_store_server_name_length) }
        val value = ServerConfiguration(existing?.id ?: UUID.randomUUID().toString(), base, name.trim(), allowLocalHttp, existing?.serverName?.takeIf { existing.url == base }, existing?.instanceId?.takeIf { existing.url == base })
        val edit = prefs.edit().putString("servers_v1", gson.toJson(if (existing == null) records + value else records.map { if (it.id == id) value else it }))
        if (existing != null && existing.url != base) {
            prefs.all.keys.filter { it.startsWith("server:${existing.id}:route_cookie:") }.forEach(edit::remove)
            listOf("routes", "active_route", "manual_route").forEach { edit.remove(field(it, existing.id)) }
            listOf("session_ciphertext", "cache_profile", "account", "account_ciphertext").forEach { edit.remove(field(it, existing.id)) }
            if (id == activeServerId) { validUntil = 0; generation = UUID.randomUUID().toString() }
        }
        check(edit.commit()); publish(); return value
    }
    @Synchronized fun updateServerInfo(info: ServerInfo) {
        val values = records().map { if (it.id == activeServerId) it.copy(serverName = info.name, instanceId = info.instance_id) else it }
        check(prefs.edit().putString("servers_v1", gson.toJson(values)).commit()); publish()
    }
    @Synchronized fun selectServer(id: String) {
        require(records().any { it.id == id }) { AppLanguage.string(R.string.sess_store_server_not_found) }
        if (id == activeServerId) return
        check(prefs.edit().putString("active_server", id).commit())
        generation = UUID.randomUUID().toString(); validUntil = 0; publish()
    }
    @Synchronized fun removeServer(id: String) {
        val edit = prefs.edit().putString("servers_v1", gson.toJson(records().filterNot { it.id == id }))
        listOf("session_ciphertext", "cache_profile", "account", "account_ciphertext").forEach { edit.remove(field(it, id)) }
        prefs.all.keys.filter { it.startsWith("server:$id:") }.forEach(edit::remove)
        if (activeServerId == id) { edit.remove("active_server"); generation = UUID.randomUUID().toString(); validUntil = 0 }
        check(edit.commit()); publish()
    }
    @Synchronized fun configure(raw: String, allowLocalHttp: Boolean) {
        val base = ServerAddress.normalize(raw, allowLocalHttp).toString()
        val existing = records().firstOrNull { it.url == base || routesFor(it.id).any { route -> route.url == base } }
        selectServer((existing ?: saveServer(null, raw, "", allowLocalHttp)).id)
        // A login form authorizes only the address it displays, even if a previous
        // visit selected a fallback route for this logical server.
        val edit = prefs.edit().putString(field("active_route"), base)
        if (routeRecords().size > 1) edit.putString(field("manual_route"), base)
        check(edit.commit())
        validUntil = 0; publish()
    }
    @Synchronized fun requestState(): ServerRequestState? = endpoint?.let { ServerRequestState("$activeServerId:$generation:$it", it) }
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
    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val data = Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        return "$iv:$data"
    }
    private fun decrypt(value: String): String {
        val parts = value.split(":")
        require(parts.size == 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
        return String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
    }
    @Synchronized override fun read(): String? {
        val value = prefs.getString(cookieField(), null) ?: return null
        return runCatching { decrypt(value) }.getOrElse { write(null); null }
    }
    @Synchronized override fun write(value: String?) {
        val edit = prefs.edit()
        if (value == null) {
            edit.remove(cookieField()).remove(field("cache_profile")).remove(field("account")).remove(field("account_ciphertext"))
            generation = UUID.randomUUID().toString(); validUntil = 0
        } else {
            check(activeServerId != null) { AppLanguage.string(R.string.sess_store_select_server_first) }
            if (!prefs.contains(field("cache_profile"))) edit.putString(field("cache_profile"), UUID.randomUUID().toString())
            validUntil = endpoint?.let { Cookie.parse(it, value)?.expiresAt } ?: 0
            edit.putString(cookieField(), encrypt(value))
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
        cookies.lastOrNull { it.name in setOf("wildstring_session", "wildstring_session_http", "wildstring_session_https") && it.matches(url) }?.let { vault.write(if (it.expiresAt <= System.currentTimeMillis()) null else it.toString()) }
    }
}
