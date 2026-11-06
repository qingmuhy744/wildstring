package com.wildstring.app.data

import com.google.gson.Gson
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
            if (it.code == 403 && it.peekBody(4096).string().contains("https_required")) throw IOException("此线路要求 HTTPS")
            if (it.code >= 500) throw IOException("服务器暂不可用")
            if (!it.isSuccessful) return null
            try { gson.fromJson(it.body!!.string(), AuthStatus::class.java) }
            catch (error: com.google.gson.JsonParseException) { throw IOException("无效的服务器响应", error) }
        }
    }
    suspend fun add(name: String, raw: String, allowHttp: Boolean, username: String, password: String) = withContext(Dispatchers.IO) {
        lock.withLock {
            val owner = store.activeServerId
            val server = store.servers.value.first { it.id == owner }
            val user = store.account ?: error("请先登录当前服务器。")
            check(server.instanceId != null) { "请升级服务端并连接后再添加线路。" }
            val base = ServerAddress.normalize(raw, allowHttp)
            require(name.trim().length in 1..80) { "线路名称应为 1–80 个字符。" }
            val existing = store.routeRecords().firstOrNull { it.url == base.toString() }
            val info = client.newCall(Request.Builder().url(base.resolve("api/v1/server")!!).build()).execute().use {
                check(it.isSuccessful) { "无法读取服务器信息。" }; gson.fromJson(it.body!!.string(), ServerInfo::class.java)
            }
            check(info.instance_id == server.instanceId) { "这条线路不属于当前服务器。" }
            val payload = gson.toJson(LoginRequest(username.trim(), password)).toRequestBody("application/json".toMediaType())
            val cookie = client.newCall(Request.Builder().url(base.resolve("api/v1/auth/login")!!).header("X-Wildstring-Client", "android").post(payload).build()).execute().use {
                check(it.isSuccessful) { "线路登录失败，请检查账号。" }
                val account = gson.fromJson(it.body!!.string(), Account::class.java)
                check(account.id == user.id) { "请使用与当前服务器相同的账号。" }
                Cookie.parseAll(base, it.headers).lastOrNull { cookie -> cookie.name in setOf("wildstring_session", "wildstring_session_http", "wildstring_session_https") && cookie.matches(base) }
                    ?: error("服务器未返回可用会话。")
            }
            check(store.activeServerId == owner && store.account?.id == user.id) { "服务器或账号已变化。" }
            store.saveRoute(ServerRoute(name.trim(), base.toString(), allowHttp), cookie.toString())
            status.value = if (existing == null) "线路已独立登录并保存" else "线路会话已更新"
        }
    }
    suspend fun select(address: String?) = withContext(Dispatchers.IO) {
        lock.withLock {
            failedPlaybackRoutes.clear()
            val previous = store.manualRoute
            store.setRouteMode(address)
            val chosen = choose(if (address == null) store.routeRecords() else store.routeRecords().filter { it.url == address })
            if (!chosen) { store.setRouteMode(previous); status.value = "线路选择未完成，已保留原模式和连接" }
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
        status.value = if (store.manualRoute == null) "没有可用的已登录线路，请检查网络或重新登录" else "手动线路不可用，未切换其他线路"
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
                if (status(route)?.authenticated != true) status.value = "当前线路登录已过期，请重新登录"
                else { failures = 0; status.value = null }
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: IOException) {
                failures++
                if (store.manualRoute != null) { status.value = "手动线路连接失败，未切换线路"; return@withLock }
                if (failures >= 2) choose(store.routeRecords().filter { it.url != route.url })
            }
        }
    }
}
