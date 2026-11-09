package com.wildstring.app.data

import com.wildstring.app.AppLanguage
import com.wildstring.app.R
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
internal fun JsonObject.objectOrNull(key: String): JsonObject? = get(key)?.takeIf { it.isJsonObject }?.asJsonObject
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
        code == "podcast_subscriptions_disabled" -> AppLanguage.string(R.string.agent_plat_err_podcast_subscriptions_disabled)
        code == "podcast_not_found" -> AppLanguage.string(R.string.agent_plat_err_podcast_not_found)
        code == "podcast_publisher_not_found" -> AppLanguage.string(R.string.agent_plat_err_podcast_publisher_not_found)
        code == "podcast_publisher_conflict" -> AppLanguage.string(R.string.agent_plat_err_podcast_publisher_conflict)
        code == "podcast_playback_settings_not_found" -> AppLanguage.string(R.string.agent_plat_err_podcast_playback_settings_not_found)
        code == "episode_not_found" -> AppLanguage.string(R.string.agent_plat_err_episode_not_found)
        code == "episode_unavailable" -> AppLanguage.string(R.string.agent_plat_err_episode_unavailable)
        code == "podcast_search_upstream_rate_limited" -> AppLanguage.string(R.string.agent_plat_err_podcast_search_upstream_rate_limited)
        code == "podcast_search_rate_limited" -> AppLanguage.string(R.string.agent_plat_err_podcast_search_rate_limited)
        code in listOf("podcast_search_timeout", "podcast_search_upstream_failed") -> AppLanguage.string(R.string.agent_plat_err_podcast_search_failed)
        code in listOf("podcast_feed_fetch_failed", "podcast_feed_parse_failed") -> AppLanguage.string(R.string.agent_plat_err_podcast_feed_failed)
        code == "invalid_avatar" -> AppLanguage.string(R.string.agent_plat_err_invalid_avatar)
        code == "avatar_too_large" -> AppLanguage.string(R.string.agent_plat_err_avatar_too_large)
        code == "source_plugin_invalid_zip" -> AppLanguage.string(R.string.agent_plat_err_source_plugin_invalid_zip)
        code == "source_plugin_identity_conflict" -> AppLanguage.string(R.string.agent_plat_err_source_plugin_identity_conflict)
        code == "source_plugin_dependency_missing" -> AppLanguage.string(R.string.agent_plat_err_source_plugin_dependency_missing)
        code == "source_plugins_disabled" -> AppLanguage.string(R.string.agent_plat_err_source_plugins_disabled)
        code == "source_plugin_auth_or_rejected" -> AppLanguage.string(R.string.agent_plat_err_source_plugin_auth_or_rejected)
        code == "source_plugin_timeout" -> AppLanguage.string(R.string.agent_plat_err_source_plugin_timeout)
        code == "source_plugin_disabled" -> AppLanguage.string(R.string.agent_plat_err_source_plugin_disabled)
        code == "source_plugin_configuration_changed" -> AppLanguage.string(R.string.agent_plat_err_source_plugin_configuration_changed)
        code == "source_plugin_worker_failed" -> AppLanguage.string(R.string.agent_plat_err_source_plugin_worker_failed)
        code == "loudness_tool_missing" -> AppLanguage.string(R.string.agent_plat_err_loudness_tool_missing)
        code == "conversation_busy" -> AppLanguage.string(R.string.agent_plat_err_conversation_busy)
        code == "search_provider_key_required" -> AppLanguage.string(R.string.agent_plat_err_search_provider_key_required)
        code == "search_daily_budget_exhausted" -> AppLanguage.string(R.string.agent_plat_err_search_daily_budget_exhausted)
        code == "native_search_requires_deepseek_pro" -> AppLanguage.string(R.string.agent_plat_err_native_search_requires_deepseek_pro)
        code == "ai_output_incomplete" -> AppLanguage.string(R.string.agent_plat_err_ai_output_incomplete)
        code == "application_policy_version_conflict" -> AppLanguage.string(R.string.agent_plat_err_application_policy_version_conflict)
        code == "draft_preview_required" -> AppLanguage.string(R.string.agent_plat_err_draft_preview_required)
        code == "album_membership_changed" -> AppLanguage.string(R.string.agent_plat_err_album_membership_changed)
        code == "cover_candidate_changed" -> AppLanguage.string(R.string.agent_plat_err_cover_candidate_changed)
        code == "cover_snapshot_unavailable" -> AppLanguage.string(R.string.agent_plat_err_cover_snapshot_unavailable)
        code == "metadata_version_conflict" -> AppLanguage.string(R.string.agent_plat_err_metadata_version_conflict)
        code == "ai_output_limit" -> AppLanguage.string(R.string.agent_plat_err_ai_output_limit)
        code == "ai_content_filtered" -> AppLanguage.string(R.string.agent_plat_err_ai_content_filtered)
        code == "ai_response_failed" -> AppLanguage.string(R.string.agent_plat_err_ai_response_failed)
        code == "memory_limit_reached" -> AppLanguage.string(R.string.agent_plat_err_memory_limit_reached)
        status == 401 -> AppLanguage.string(R.string.agent_plat_err_status_401)
        status == 403 -> AppLanguage.string(R.string.agent_plat_err_status_403)
        status == 404 -> AppLanguage.string(R.string.agent_plat_err_status_404)
        status == 409 -> AppLanguage.string(R.string.agent_plat_err_status_409)
        status == 410 -> AppLanguage.string(R.string.agent_plat_err_status_410)
        status == 429 -> AppLanguage.string(R.string.agent_plat_err_status_429)
        code.contains("endpoint") || code.contains("host") -> AppLanguage.string(R.string.agent_plat_err_endpoint_policy)
        code.contains("capabil") || code.contains("tool") -> AppLanguage.string(R.string.agent_plat_err_tool_capability)
        code.contains("budget") -> AppLanguage.string(R.string.agent_plat_err_budget_insufficient)
        code.contains("connection") -> AppLanguage.string(R.string.agent_plat_err_connection_unavailable)
        code.contains("verif") -> AppLanguage.string(R.string.agent_plat_err_verification_failed)
        status == 422 || status == 400 -> AppLanguage.string(R.string.agent_plat_err_validation_failed)
        else -> AppLanguage.string(R.string.agent_plat_err_generic, status)
    }
    return description + diagnosticId(traceId)?.let { "\n" + AppLanguage.string(R.string.agent_plat_diagnostic_id, it) }.orEmpty()
}

internal fun inspectionStage(stage: String, status: String): String = when (stage) {
    "completed" -> if (status == "succeeded") AppLanguage.string(R.string.agent_plat_stage_completed_succeeded) else AppLanguage.string(R.string.agent_plat_stage_completed_partial)
    "rules" -> AppLanguage.string(R.string.agent_plat_stage_rules)
    "model_call" -> AppLanguage.string(R.string.agent_plat_stage_model_call)
    "analysis_complete" -> AppLanguage.string(R.string.agent_plat_stage_analysis_complete)
    "queued" -> AppLanguage.string(R.string.agent_plat_stage_queued)
    else -> AppLanguage.string(R.string.agent_plat_stage_paused)
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
    private fun requireOwner(owner: String?) { if (owner == null || owner != repository.session.cacheScope()) throw CancellationException(AppLanguage.string(R.string.agent_plat_err_session_changed)) }
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
            require(items.isNotEmpty() && offset < 10_000) { AppLanguage.string(R.string.agent_plat_err_list_too_large) }
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
            require(items.isNotEmpty() && (full || cursor != null)) { AppLanguage.string(R.string.agent_plat_err_notifications_incomplete) }
        }
        // Do not advance the cursor on an incomplete sync: the next retry can safely replay it.
        throw IOException(AppLanguage.string(R.string.agent_plat_err_notifications_too_many))
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
