package com.wildstring.app.data

import com.google.gson.Gson
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType

interface ServerRouteSessions {
    val activeServerId: String?
    val account: Account?
    val servers: kotlinx.coroutines.flow.StateFlow<List<ServerConfiguration>>
    val activeRouteUrl: String?
    val manualRoute: String?
    fun routeRecords(): List<ServerRoute>
    fun routeCookie(url: String): String?
    fun saveRoute(route: ServerRoute, cookie: String)
    fun selectRoute(route: ServerRoute)
    fun setRouteMode(address: String?)
}

/** Probes only previously configured routes; each carries its own encrypted session. */
class ServerRouteManager(private val store: ServerRouteSessions) {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).connectTimeout(4, TimeUnit.SECONDS).callTimeout(6, TimeUnit.SECONDS).build()
    private val gson = Gson()
    private val lock = Mutex()
    private val changed = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val changes = changed.asSharedFlow()
    private val status = MutableStateFlow<String?>(null)
    val message = status.asStateFlow()
    private var failures = 0
    private val failedPlaybackRoutes = mutableSetOf<String>()

    private fun status(route: ServerRoute): AuthStatus? {
        val base = ServerAddress.normalize(route.url, route.allowHttp)
        val cookie = store.routeCookie(route.url)?.let { Cookie.parse(base, it) } ?: return null
        if (cookie.expiresAt <= System.currentTimeMillis() || !cookie.matches(base)) return null
        val request = Request.Builder().url(base.resolve("api/v1/auth/status")!!)
            .header("Cookie", "${cookie.name}=${cookie.value}").header("X-Wildstring-Client", "android").build()
        return client.newCall(request).execute().use {
            if (it.code == 403 && it.peekBody(4096).string().contains("https_required")) throw IOException(AppLanguage.string(R.string.srv_route_https_required))
            if (it.code >= 500) throw IOException(AppLanguage.string(R.string.srv_route_server_unavailable))
            if (!it.isSuccessful) return null
            try { gson.fromJson(it.body!!.string(), AuthStatus::class.java) }
            catch (error: com.google.gson.JsonParseException) { throw IOException(AppLanguage.string(R.string.srv_route_invalid_response), error) }
        }
    }
    suspend fun add(name: String, raw: String, allowHttp: Boolean, username: String, password: String) = withContext(Dispatchers.IO) {
        lock.withLock {
            val owner = store.activeServerId
            val server = store.servers.value.first { it.id == owner }
            val user = store.account ?: error(AppLanguage.string(R.string.srv_route_login_first))
            check(server.instanceId != null) { AppLanguage.string(R.string.srv_route_upgrade_server_hint) }
            val base = ServerAddress.normalize(raw, allowHttp)
            require(name.trim().length in 1..80) { AppLanguage.string(R.string.srv_route_name_length) }
            val existing = store.routeRecords().firstOrNull { it.url == base.toString() }
            val info = client.newCall(Request.Builder().url(base.resolve("api/v1/server")!!).build()).execute().use {
                check(it.isSuccessful) { AppLanguage.string(R.string.srv_route_cannot_read_info) }; gson.fromJson(it.body!!.string(), ServerInfo::class.java)
            }
            check(info.instance_id == server.instanceId) { AppLanguage.string(R.string.srv_route_mismatched_server) }
            val payload = gson.toJson(LoginRequest(username.trim(), password)).toRequestBody("application/json".toMediaType())
            val cookie = client.newCall(Request.Builder().url(base.resolve("api/v1/auth/login")!!).header("X-Wildstring-Client", "android").post(payload).build()).execute().use {
                check(it.isSuccessful) { AppLanguage.string(R.string.srv_route_login_failed) }
                val account = gson.fromJson(it.body!!.string(), Account::class.java)
                check(account.id == user.id) { AppLanguage.string(R.string.srv_route_mismatched_account) }
                Cookie.parseAll(base, it.headers).lastOrNull { cookie -> cookie.name in setOf("wildstring_session", "wildstring_session_http", "wildstring_session_https") && cookie.matches(base) }
                    ?: error(AppLanguage.string(R.string.srv_route_no_session_returned))
            }
            check(store.activeServerId == owner && store.account?.id == user.id) { AppLanguage.string(R.string.srv_route_server_or_account_changed) }
            store.saveRoute(ServerRoute(name.trim(), base.toString(), allowHttp), cookie.toString())
            status.value = if (existing == null) AppLanguage.string(R.string.srv_route_logged_in_and_saved) else AppLanguage.string(R.string.srv_route_session_updated)
        }
    }
    suspend fun select(address: String?) = withContext(Dispatchers.IO) {
        lock.withLock {
            failedPlaybackRoutes.clear()
            val previous = store.manualRoute
            store.setRouteMode(address)
            val chosen = choose(if (address == null) store.routeRecords() else store.routeRecords().filter { it.url == address })
            if (!chosen) { store.setRouteMode(previous); status.value = AppLanguage.string(R.string.srv_route_selection_incomplete) }
        }
    }
    private fun choose(routes: List<ServerRoute>): Boolean {
        val owner = store.activeServerId
        val account = store.account?.id
        val server = store.servers.value.firstOrNull { it.id == owner } ?: return false
        for (route in routes) {
            val candidate = try { status(route) } catch (_: IOException) { continue }
            if (candidate?.authenticated != true || candidate.user?.id != account || candidate.server?.instance_id != server.instanceId) continue
            if (store.activeServerId != owner || store.account?.id != account) return false
            if (store.activeRouteUrl != route.url) { store.selectRoute(route); changed.tryEmit(route.url) }
            failures = 0; status.value = null; return true
        }
        status.value = if (store.manualRoute == null) AppLanguage.string(R.string.srv_route_no_available_route) else AppLanguage.string(R.string.srv_route_manual_unavailable_no_switch)
        return false
    }
    suspend fun playbackConnectionFailed(address: String?) = withContext(Dispatchers.IO) {
        lock.withLock {
            if (address == null || store.activeRouteUrl != address || store.manualRoute != null) return@withLock
            failedPlaybackRoutes.add(address)
            choose(store.routeRecords().filter { it.url !in failedPlaybackRoutes })
        }
    }
    suspend fun monitor() {
        while (true) {
            probe()
            delay(10_000)
        }
    }
    suspend fun probe() = withContext(Dispatchers.IO) {
        lock.withLock {
            if (store.routeRecords().size < 2 || store.account == null) return@withLock
            val route = store.routeRecords().firstOrNull { it.url == store.activeRouteUrl } ?: return@withLock
            try {
                if (status(route)?.authenticated != true) status.value = AppLanguage.string(R.string.srv_route_current_expired)
                else { failures = 0; status.value = null }
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: IOException) {
                failures++
                if (store.manualRoute != null) { status.value = AppLanguage.string(R.string.srv_route_manual_connect_failed_no_switch); return@withLock }
                if (failures >= 2) choose(store.routeRecords().filter { it.url != route.url })
            }
        }
    }
}
