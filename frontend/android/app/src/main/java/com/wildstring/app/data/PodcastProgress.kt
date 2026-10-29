package com.wildstring.app.data

import android.content.Context
import com.google.gson.Gson
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import retrofit2.HttpException

data class EpisodeCheckpoint(
    val remote: EpisodeProgress, val update: PodcastProgressUpdate,
    val dirty: Boolean = true, val conflict: Boolean = false,
) {
    fun conflictsWith(value: EpisodeProgress) = dirty && (conflict ||
        (update.sessionId != value.sessionId && update.baseVersion != value.version))
    fun checkpoint(position: Long, duration: Long, event: String): EpisodeCheckpoint {
        val seconds = (position / 1000).coerceAtLeast(0)
        val kind = if (update.event == "ended" && seconds == update.positionSeconds && event in listOf("stop", "pause", "progress")) "ended" else event
        if (seconds == update.positionSeconds && kind == update.event) return this
        return copy(update = update.copy(sequence = update.sequence + 1, positionSeconds = seconds,
            durationSeconds = if (duration > 0) duration / 1000 else update.durationSeconds, event = kind), dirty = true)
    }
    fun acknowledged(sent: PodcastProgressUpdate, value: EpisodeProgress): EpisodeCheckpoint =
        if (sent.sessionId != update.sessionId) this else copy(remote = value, dirty = update.sequence > sent.sequence)
}
data class EpisodeProgressPrompt(val title: String, val remoteMs: Long, val localMs: Long, val conflict: Boolean)

/** Episode bookmarks live outside the queue. The service owns checkpoints; UI only answers conflicts. */
@Singleton
class PodcastProgress @Inject constructor(
    @ApplicationContext context: Context, private val repository: Repository,
) {
    private val prefs = context.getSharedPreferences("podcast-progress", Context.MODE_PRIVATE)
    private val device = prefs.getString("device", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("device", it).apply() }
    private val gson = Gson()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val stateLock = Mutex()
    private val networkLocks = mutableMapOf<String, Mutex>()
    private val lastSent = mutableMapOf<String, Long>()
    private var active: Triple<String, String, String>? = null
    private var activeConflicted = false
    private val mutablePrompt = MutableStateFlow<EpisodeProgressPrompt?>(null)
    val prompt = mutablePrompt.asStateFlow()
    private var answer: CompletableDeferred<Boolean?>? = null
    private val mutableMessage = MutableStateFlow<String?>(null)
    val message = mutableMessage.asStateFlow()
    private val mutableMode = MutableStateFlow(modeForOwner())
    val mode = mutableMode.asStateFlow()
    private val mutablePositions = MutableStateFlow<Map<String, EpisodeProgress>>(emptyMap())
    val positions = mutablePositions.asStateFlow()
    init {
        scope.launch { repository.session.profiles.collect { owner ->
            yield()
            if (owner != repository.session.cacheScope()) return@collect
            leave(); answer?.complete(null); mutablePrompt.value = null; mutableMessage.value = null
            mutablePositions.value = emptyMap()
            mutableMode.value = modeForOwner()
            flushAll()
        } }
    }
    private fun modeForOwner() = prefs.getString("mode:${repository.session.storageScope()}", "ask").takeIf { it in listOf("ask", "auto", "restart") } ?: "ask"
    fun mode(value: String) { require(value in listOf("ask", "auto", "restart")); prefs.edit().putString("mode:${repository.session.storageScope()}", value).apply(); mutableMode.value = value }
    fun answer(useRemote: Boolean?) { answer?.complete(useRemote) }
    fun leave() { active = null; activeConflicted = false }
    fun owns(id: String) = !activeConflicted && active?.let { it.first == repository.session.cacheScope() && it.second == id } == true
    private fun ownerValid(owner: String) { if (owner != repository.session.cacheScope()) throw CancellationException("会话已变化。") }
    // Requests use the ephemeral login generation; durable rows use the stable server/account key.
    private fun storageOwner(owner: String): String = repository.session.withStorageScope(owner) { it }
        ?: throw CancellationException("会话已变化。")
    private suspend fun read(owner: String, id: String): EpisodeCheckpoint? =
        repository.database.podcasts().get(storageOwner(owner), id)?.let { runCatching { gson.fromJson(it.payload, EpisodeCheckpoint::class.java) }.getOrNull() }
    private suspend fun save(owner: String, id: String, value: EpisodeCheckpoint) =
        repository.database.podcasts().save(PodcastCheckpointRow(storageOwner(owner), id, gson.toJson(value)))
    private suspend fun <T> request(block: suspend () -> T): T = try { withTimeout(6000) { block() } }
        catch (_: TimeoutCancellationException) { throw IOException("单集进度暂未同步。") }

    /** Only called for a play/seek intent, never on passive restoration or background retry. */
    suspend fun prepare(id: String, title: String, durationMs: Long, requestedMs: Long? = null, automatic: Boolean = false): Long? {
        val owner = repository.session.cacheScope() ?: return null
        flush(owner, id)
        val local = stateLock.withLock { read(owner, id) }
        val remote = try { request { repository.api().podcastProgress(id, RequestOwner(owner)) } }
            catch (error: IOException) { local?.remote ?: EpisodeProgress(id) }
        ownerValid(owner)
        val conflict = local?.conflictsWith(remote) == true
        val localPosition = requestedMs ?: (local?.update?.positionSeconds ?: 0) * 1000
        var position = requestedMs ?: if (local?.dirty == true && !conflict) local.update.positionSeconds * 1000
            else if (remote.completed) 0 else remote.positionSeconds * 1000
        if (conflict || (requestedMs == null && position > 0 && mode.value == "ask" && !automatic && !owns(id))) {
            val deferred = CompletableDeferred<Boolean?>()
            answer?.complete(null); answer = deferred
            mutablePrompt.value = EpisodeProgressPrompt(title, if (remote.completed) 0 else remote.positionSeconds * 1000,
                if (conflict) localPosition else 0, conflict)
            val choice = try { deferred.await() } finally { if (answer === deferred) { answer = null; mutablePrompt.value = null } }
            if (choice == null) return null
            position = if (choice) { if (remote.completed) 0 else remote.positionSeconds * 1000 }
                else if (conflict) localPosition else 0
        } else if (requestedMs == null && mode.value == "restart") position = 0
        ownerValid(owner)
        val session = UUID.randomUUID().toString()
        val value = EpisodeCheckpoint(remote, PodcastProgressUpdate(session, device, remote.version, 1,
            (position / 1000).coerceAtLeast(0), (durationMs / 1000).coerceAtLeast(0), "play"))
        stateLock.withLock { ownerValid(owner); save(owner, id, value); active = Triple(owner, id, session); activeConflicted = false }
        mutableMessage.value = null
        flush(owner, id)
        ownerValid(owner)
        if (stateLock.withLock { read(owner, id)?.conflict } == true) { leave(); return null }
        return position
    }
    fun checkpoint(id: String, positionMs: Long, durationMs: Long, event: String, force: Boolean = false) {
        val session = active?.takeIf { it.first == repository.session.cacheScope() && it.second == id } ?: return
        scope.launch {
            try {
                stateLock.withLock {
                    ownerValid(session.first)
                    val value = read(session.first, id)?.takeIf { it.update.sessionId == session.third } ?: return@withLock
                    save(session.first, id, value.checkpoint(positionMs, durationMs, event))
                }
                if (force || android.os.SystemClock.elapsedRealtime() - (lastSent["${session.first}:$id"] ?: 0) >= 10_000) flush(session.first, id)
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { mutableMessage.value = "单集进度暂未同步，请检查网络或存储空间。" }
        }
    }
    fun playbackProblem() { mutableMessage.value = "暂时无法读取单集进度，请重试。" }
    fun retry() { scope.launch { flushAll(throttle = true) } }
    private suspend fun flushAll(throttle: Boolean = false) {
        val owner = repository.session.cacheScope() ?: return
        for (row in repository.database.podcasts().all(storageOwner(owner))) {
            if (owner != repository.session.cacheScope()) return
            if (!throttle || android.os.SystemClock.elapsedRealtime() - (lastSent["$owner:${row.episodeId}"] ?: 0) >= 10_000) flush(owner, row.episodeId)
        }
    }
    private suspend fun flush(owner: String, id: String) {
        val key = "$owner:$id"
        networkLocks.getOrPut(key) { Mutex() }.withLock {
            ownerValid(owner)
            val pending = stateLock.withLock { read(owner, id) }?.takeIf { it.dirty && !it.conflict } ?: return@withLock
            lastSent[key] = android.os.SystemClock.elapsedRealtime()
            try {
                val remote = request { repository.api().updatePodcastProgress(id, pending.update, RequestOwner(owner)) }
                stateLock.withLock {
                    ownerValid(owner)
                    val latest = read(owner, id) ?: return@withLock
                    save(owner, id, latest.acknowledged(pending.update, remote))
                    if (latest.update.sessionId == pending.update.sessionId) mutablePositions.value = mutablePositions.value + (id to remote)
                }
            } catch (error: CancellationException) { throw error }
            catch (error: HttpException) {
                if (owner != repository.session.cacheScope()) return@withLock
                if (error.code() == 409) stateLock.withLock {
                    val latest = read(owner, id)?.takeIf { it.update.sessionId == pending.update.sessionId } ?: return@withLock
                    save(owner, id, latest.copy(conflict = true))
                    // Keep checkpointing locally if playback continues, but never upload or
                    // treat a deliberate seek as owned until the user resolves the conflict.
                    if (active == Triple(owner, id, pending.update.sessionId)) activeConflicted = true
                    mutableMessage.value = "另一台设备更新了本集。本机进度已保留，下次播放时请选择接续位置。"
                } else if (error.code() == 422) mutableMessage.value = "请更新服务器以同步播客进度，本机进度已保存。"
            } catch (_: IOException) { /* Persisted outbox is retried; never turn a retry into a new claim. */ }
        }
    }
}
