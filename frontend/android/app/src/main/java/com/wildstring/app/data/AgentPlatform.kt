package com.wildstring.app.data

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import java.util.concurrent.TimeUnit

class AgentRequestPolicy
class AgentTimeoutInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): okhttp3.Response =
        (if (chain.request().tag(AgentRequestPolicy::class.java) != null) chain.withReadTimeout(180, TimeUnit.SECONDS) else chain).proceed(chain.request())
}

internal fun JsonObject.text(key: String, fallback: String = ""): String = get(key)?.takeUnless { it.isJsonNull }?.let { runCatching { it.asString }.getOrNull() } ?: fallback
internal fun JsonObject.number(key: String, fallback: Long = 0): Long = get(key)?.let { runCatching { it.asLong }.getOrNull() } ?: fallback
internal fun JsonObject.flag(key: String): Boolean = get(key)?.let { runCatching { it.asBoolean }.getOrNull() } ?: false
internal fun JsonObject.objects(key: String = "items"): List<JsonObject> = getAsJsonArray(key)?.filter { it.isJsonObject }?.map { it.asJsonObject } ?: emptyList()
internal fun jsonBody(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject().apply { pairs.forEach { (key, value) ->
    when (value) { null -> add(key, com.google.gson.JsonNull.INSTANCE); is String -> addProperty(key, value); is Number -> addProperty(key, value); is Boolean -> addProperty(key, value); is JsonElement -> add(key, value); else -> error("Unsupported JSON value") }
} }
internal fun jsonStrings(values: List<String>) = JsonArray().apply { values.forEach(::add) }

class AgentApiException(val status: Int, val code: String, val traceId: String?) : IOException(agentError(status, code, traceId))
internal fun diagnosticId(value: String?): String? = value?.takeIf { it.matches(Regex("[a-fA-F0-9]{16,64}")) }
internal fun agentError(status: Int, code: String, traceId: String?): String {
    val description = when {
        code == "source_plugin_invalid_zip" -> "插件 ZIP 不符合格式，请检查包结构与 API 版本。"
        code == "source_plugin_identity_conflict" -> "此 ZIP 的插件 ID 不同，请选择对应插件的升级包。"
        code == "source_plugin_dependency_missing" -> "运行环境缺少插件依赖，请按插件说明配置。"
        code == "source_plugins_disabled" -> "请先导入并启用提供歌词的数据源插件。"
        code == "source_plugin_auth_or_rejected" -> "上游拒绝请求，请检查插件服务和平台授权。"
        code == "source_plugin_timeout" -> "插件查询超时，请检查服务地址或稍后重试。"
        code == "loudness_tool_missing" -> "服务端缺少 FFmpeg，请更新官方镜像或安装后重试。"
        code == "conversation_busy" -> "这段对话正在生成回复，请完成后再操作。"
        code == "search_provider_key_required" -> "请填写所选搜索服务的 API Key，再启用联网。"
        code == "search_daily_budget_exhausted" -> "今日搜索与读取请求已达到上限。"
        code == "native_search_requires_deepseek_pro" -> "DeepSeek 原生联网需要支持该功能的 Pro 模型。"
        code == "ai_output_incomplete" -> "模型输出未完成，请提高输出 Token 上限或缩小问题范围。"
        code == "memory_limit_reached" -> "长期记忆已达 50 条，请先整理旧条目。"
        status == 401 -> "登录已失效，请重新登录。"
        status == 403 -> "当前账号没有这项操作的权限。"
        status == 404 -> "此功能或内容在当前服务器不可用，请确认服务端已同步升级。"
        status == 409 -> "内容或版本已变化，请刷新并重新核对。"
        status == 410 -> "通知同步位置已过期，正在重新读取。"
        status == 429 -> "已达到调用或预算限制，请稍后重试。"
        code.contains("endpoint") || code.contains("host") -> "此 AI 地址不符合服务端端点策略，请联系管理员。"
        code.contains("capabil") || code.contains("tool") -> "此连接尚未通过工具调用检测，请先检测连接。"
        code.contains("budget") -> "调用预算不足，请调整预算或稍后重试。"
        code.contains("connection") -> "AI 连接不可用，请检查连接、权限和设置。"
        code.contains("verif") -> "目标尚未验证或验证码已失效，请重新验证。"
        status == 422 || status == 400 -> "输入未通过校验，请检查内容后重试。"
        else -> "操作未完成，请刷新状态后重试（$status）。"
    }
    return description + diagnosticId(traceId)?.let { "\n诊断编号：$it" }.orEmpty()
}

data class AgentInboxState(val owner: String? = null, val items: List<JsonObject> = emptyList(), val unread: Int = 0,
    val highWatermark: Long = 0, val cursor: String? = null, val loading: Boolean = false,
    val supported: Boolean? = null, val error: String? = null)

/** Inbox reads never change read state. A cursor belongs to one selected server and account. */
class AgentPlatform(private val repository: Repository) {
    private val inboxMutable = MutableStateFlow(AgentInboxState())
    val inbox = inboxMutable.asStateFlow()
    private val syncLock = Mutex()
    fun reset() { inboxMutable.value = AgentInboxState(owner = repository.session.cacheScope()) }
    private fun requireOwner(owner: String?) { if (owner == null || owner != repository.session.cacheScope()) throw CancellationException("服务器或账号已变化。") }
    suspend fun request(path: String, method: String = "GET", body: JsonObject = JsonObject(), query: Map<String, String> = emptyMap()): JsonObject {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        val segments = path.split('/').filter { it.isNotBlank() }
        require(segments.none { it == "." || it == ".." })
        val target = repository.url("api", "v1", "agent", *segments.toTypedArray()).toHttpUrl().newBuilder().apply {
            query.forEach { (key, value) -> addQueryParameter(key, value) }
        }.build().toString()
        val api = repository.agentApi()
        val response = when (method) {
            "GET" -> api.agentGet(target); "POST" -> api.agentPost(target, body,
                if (segments.lastOrNull() in listOf("messages", "test")) AgentRequestPolicy() else null); "PATCH" -> api.agentPatch(target, body)
            "PUT" -> api.agentPut(target, body); "DELETE" -> api.agentDelete(target); else -> error("Unsupported method")
        }
        requireOwner(owner)
        if (!response.isSuccessful) {
            val code = response.errorBody()?.use { runCatching { JsonParser.parseString(it.string()).asJsonObject.text("detail") }.getOrDefault("") }.orEmpty()
            throw AgentApiException(response.code(), code, diagnosticId(response.headers()["X-Wildstring-Trace-Id"]))
        }
        return response.body() ?: JsonObject()
    }
    suspend fun all(path: String): List<JsonObject> {
        val result = mutableListOf<JsonObject>()
        var offset = 0
        do {
            val page = request(path, query = mapOf("limit" to "100", "offset" to offset.toString()))
            val items = page.objects()
            result += items; offset += items.size
            if (offset >= page.number("total").toInt()) return result
            require(items.isNotEmpty() && offset < 10_000) { "列表过大或读取不完整，请在网页中筛选。" }
        } while (true)
    }
    suspend fun refreshInbox(force: Boolean = false) = syncLock.withLock {
        val owner = repository.session.cacheScope() ?: return@withLock
        if (inboxMutable.value.owner != owner) reset()
        val previous = inboxMutable.value
        inboxMutable.value = previous.copy(loading = true, error = null)
        try {
            try { syncInbox(owner, full = force || previous.cursor == null) }
            catch (error: AgentApiException) { if (error.status != 410) throw error; syncInbox(owner, full = true) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (owner == repository.session.cacheScope()) inboxMutable.value = inboxMutable.value.copy(loading = false,
                supported = if (error is AgentApiException && error.status == 404) false else inboxMutable.value.supported,
                error = if (error is AgentApiException) error.message else friendlyError(error))
        } finally { if (owner == repository.session.cacheScope()) inboxMutable.value = inboxMutable.value.copy(loading = false) }
    }
    private suspend fun syncInbox(owner: String, full: Boolean) {
        val changes = mutableListOf<JsonObject>()
        var offset = 0
        var cursor = if (full) null else inboxMutable.value.cursor
        var snapshotCursor: String? = null
        repeat(100) {
            val query = mutableMapOf("limit" to "100")
            if (full) query["offset"] = offset.toString() else cursor?.let { query["cursor"] = it }
            val page = request("notifications", query = query)
            if (full && offset == 0) snapshotCursor = page.text("next_cursor").takeIf { it.isNotBlank() }
            val items = page.objects(); changes += items; offset += items.size
            cursor = page.text("next_cursor").takeIf { it.isNotBlank() }
            val done = if (full) offset >= page.number("total") else items.size < 100
            if (done) {
                requireOwner(owner)
                val merged = mergeInbox(if (full) emptyList() else inboxMutable.value.items, changes)
                inboxMutable.value = AgentInboxState(owner, merged, page.number("unread_count").toInt(), page.number("high_watermark"), if (full) snapshotCursor else cursor, supported = true)
                // An insert/read on another device can shift offset pages while loading.
                // Replay changes since the FIRST page before committing the final sync point.
                if (full && snapshotCursor != null) syncInbox(owner, full = false)
                return
            }
            require(items.isNotEmpty() && (full || cursor != null)) { "通知读取不完整，请刷新重试。" }
        }
        // Do not advance the cursor on an incomplete sync: the next retry can safely replay it.
        throw IOException("通知较多，请稍后重试或在网页中处理。")
    }
    suspend fun readNotification(id: String) {
        request("notifications/read", "POST", jsonBody("ids" to jsonStrings(listOf(id))))
        refreshInbox()
    }
    suspend fun readSnapshot() {
        val snapshot = inboxMutable.value.highWatermark
        request("notifications/read-all", "POST", jsonBody("high_watermark" to snapshot))
        refreshInbox()
    }
}

internal fun mergeInbox(existing: List<JsonObject>, changes: List<JsonObject>): List<JsonObject> {
    val merged = existing.associateByTo(linkedMapOf()) { it.text("id") }
    changes.forEach { incoming ->
        val id = incoming.text("id")
        if (id.isNotBlank() && incoming.number("version") >= (merged[id]?.number("version") ?: -1)) merged[id] = incoming
    }
    return merged.values.sortedWith(compareByDescending<JsonObject> { it.text("created_at") }.thenByDescending { it.text("id") })
}
