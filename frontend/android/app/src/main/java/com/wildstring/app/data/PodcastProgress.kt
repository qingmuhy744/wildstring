package com.wildstring.app.data

import android.content.Context
import com.google.gson.Gson
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import retrofit2.HttpException

/**
 * A play request that resumes an already prepared episode only unpauses it. Preparing again would
 * re-apply the resume mode and could restart the episode or ask for a position the user never left.
 */
fun podcastResumeNeedsPreparation(progressEntry: String?, mediaId: String?, ownsProgress: Boolean, ended: Boolean): Boolean =
    ended || progressEntry == null || mediaId == null || progressEntry != mediaId || !ownsProgress

/** Ask mode requires a visible dialog; without a host the prompt would block playback indefinitely. */
fun podcastShouldAskPosition(mode: String, requestedMs: Long?, automatic: Boolean, restart: Boolean, positionMs: Long, hosted: Boolean): Boolean =
    requestedMs == null && !automatic && !restart && mode == "ask" && positionMs > 0 && hosted

/** Only automatic continuation skips a completed episode; a user who picks it explicitly replays it from the start. */
fun podcastSkipsCompleted(completed: Boolean, automatic: Boolean, explicitRestart: Boolean = false): Boolean =
    completed && automatic && !explicitRestart

/** Restart clears the completed flag, so it also applies when the user starts a completed episode. */
fun podcastShouldRestart(completed: Boolean, automatic: Boolean, explicitRestart: Boolean, requestedMs: Long?, mode: String): Boolean =
    explicitRestart || (requestedMs == null && !automatic && mode == "restart") || (completed && !automatic)

/** The automatic-next marker belongs to one target episode and is single use, so it cannot colour a later user play. */
fun podcastAutomaticNextMatches(pendingId: String?, id: String): Boolean = pendingId != null && pendingId == id

data class EpisodeCheckpoint(
    val remote: EpisodeProgress, val update: PodcastProgressUpdate,
    val dirty: Boolean = true, val conflict: Boolean = false,
) {
    fun conflictsWith(value: EpisodeProgress) = dirty && (conflict ||
        (update.sessionId != value.sessionId && update.baseVersion != value.version &&
            (value.deviceId.isBlank() || value.deviceId != update.deviceId)))
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

/**
 * A problem the podcast page itself must report, e.g. a failed sync. Informational messages
 * ("已听完") and busy states stay in the player. [id] identifies one occurrence so a repeated
 * identical problem still restarts the page notice instead of being deduplicated on equal text.
 */
data class PodcastPageNotice(val id: Long, val message: String)
sealed interface PodcastPreparation {
    data class Play(val positionMs: Long) : PodcastPreparation
    data object Completed : PodcastPreparation
}

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
    private val mutableConflict = MutableStateFlow(false)
    val conflict = mutableConflict.asStateFlow()
    private var modeRevision = 0
    private var automaticNextId: String? = null
    fun prepareNextAutomatically(episodeId: String?) { automaticNextId = episodeId }
    /** Single use: any preparation clears the marker, and only the episode it was set for honors it. */
    fun consumeAutomaticNext(episodeId: String): Boolean =
        podcastAutomaticNextMatches(automaticNextId, episodeId).also { automaticNextId = null }
    private val mutableQueueChanges = kotlinx.coroutines.flow.MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val queueChanges = mutableQueueChanges.asSharedFlow()
    fun queueChanged() { mutableQueueChanges.tryEmit(Unit) }
    private val mutablePrompt = MutableStateFlow<EpisodeProgressPrompt?>(null)
    val prompt = mutablePrompt.asStateFlow()
    private var promptHosted = false
    private var answer: CompletableDeferred<Boolean?>? = null
    private val mutableMessage = MutableStateFlow<String?>(null)
    val message = mutableMessage.asStateFlow()
    private val mutablePageNotice = MutableStateFlow<PodcastPageNotice?>(null)
    val pageNotice = mutablePageNotice.asStateFlow()
    private var pageNoticeRevision = 0L
    private val mutableMode = MutableStateFlow(modeForOwner())
    val mode = mutableMode.asStateFlow()
    private val mutablePositions = MutableStateFlow<Map<String, EpisodeProgress>>(emptyMap())
    val positions = mutablePositions.asStateFlow()
    init {
        scope.launch { repository.session.profiles.collect { owner ->
            yield()
            if (owner != repository.session.cacheScope()) return@collect
            leave(); automaticNextId = null; answer?.complete(null); mutablePrompt.value = null; mutableMessage.value = null; mutablePageNotice.value = null
            mutablePositions.value = emptyMap()
            mutableMode.value = modeForOwner()
            refreshMode()
            flushAll()
        } }
    }
    private fun modeForOwner() = prefs.getString("account-mode:${repository.session.storageScope()}", "auto").takeIf { it in listOf("auto", "restart", "ask") } ?: "auto"
    fun refreshMode() {
        val owner = repository.session.cacheScope() ?: return
        val revision = modeRevision
        scope.launch {
            try {
                val value = request { repository.api().podcastResumeMode(RequestOwner(owner)) }.resumeMode
                if (owner == repository.session.cacheScope() && revision == modeRevision && value in listOf("auto", "restart", "ask")) {
                    prefs.edit().putString("account-mode:${repository.session.storageScope()}", value).apply()
                    mutableMode.value = value
                }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { }
        }
    }
    fun mode(value: String) {
        require(value in listOf("auto", "restart", "ask"))
        val owner = repository.session.cacheScope() ?: return
        val revision = ++modeRevision
        scope.launch {
            try {
                val saved = request { repository.api().updatePodcastResumeMode(PodcastResumeMode(value), RequestOwner(owner)) }.resumeMode
                if (owner == repository.session.cacheScope() && revision == modeRevision) {
                    prefs.edit().putString("account-mode:${repository.session.storageScope()}", saved).apply()
                    mutableMode.value = saved
                }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { pageProblem(R.string.pod_prog_sync_failed_check_network) }
        }
    }
    fun answer(useRemote: Boolean?) { answer?.complete(useRemote) }

    /** Ask mode needs a visible dialog; without one the prompt would block playback until the app returns. */
    fun setPromptHosted(hosted: Boolean) {
        promptHosted = hosted
        if (!hosted) {
            mutablePrompt.value = null
            answer?.complete(null)
        }
    }
    fun leave() { active = null; activeConflicted = false; mutableConflict.value = false }
    fun owns(id: String) = active?.let { it.first == repository.session.cacheScope() && it.second == id } == true
    fun deviceId() = device
    suspend fun recordManualProgress(id: String, progress: EpisodeProgress, completed: Boolean) {
        mutablePositions.value = mutablePositions.value + (id to progress)
        val session = active?.takeIf { it.first == repository.session.cacheScope() && it.second == id } ?: return
        stateLock.withLock {
            val latest = read(session.first, id)?.takeIf { it.update.sessionId == session.third } ?: return@withLock
            val update = latest.update.copy(sessionId = progress.sessionId, deviceId = progress.deviceId,
                baseVersion = progress.version, sequence = progress.sequence, positionSeconds = progress.positionSeconds,
                durationSeconds = progress.durationSeconds, event = if (completed) "ended" else "stop",
                intent = if (completed) "resume" else "restart")
            save(session.first, id, latest.copy(remote = progress, update = update, dirty = false, conflict = false))
            active = Triple(session.first, id, progress.sessionId)
            activeConflicted = false
            mutableConflict.value = false
        }
    }
    private fun ownerValid(owner: String) { if (owner != repository.session.cacheScope()) throw CancellationException(AppLanguage.string(R.string.pod_prog_session_changed)) }
    // Requests use the ephemeral login generation; durable rows use the stable server/account key.
    private fun storageOwner(owner: String): String = repository.session.withStorageScope(owner) { it }
        ?: throw CancellationException(AppLanguage.string(R.string.pod_prog_session_changed))
    private suspend fun read(owner: String, id: String): EpisodeCheckpoint? =
        repository.database.podcasts().get(storageOwner(owner), id)?.let { runCatching { gson.fromJson(it.payload, EpisodeCheckpoint::class.java) }.getOrNull() }
    private suspend fun save(owner: String, id: String, value: EpisodeCheckpoint) =
        repository.database.podcasts().save(PodcastCheckpointRow(storageOwner(owner), id, gson.toJson(value)))
    private suspend fun <T> request(block: suspend () -> T): T = try { withTimeout(6000) { block() } }
        catch (_: TimeoutCancellationException) { throw IOException(AppLanguage.string(R.string.pod_prog_not_synced)) }

    /** Only called for a play/seek intent, never on passive restoration or background retry. */
    suspend fun prepare(id: String, title: String, durationMs: Long, requestedMs: Long? = null, automatic: Boolean = false, fallbackMs: Long? = null, explicitRestart: Boolean = false): PodcastPreparation? {
        val owner = repository.session.cacheScope() ?: return null
        leave()
        flush(owner, id)
        val local = stateLock.withLock { read(owner, id) }
        var online = true
        val remote = try { request { repository.api().podcastProgress(id, RequestOwner(owner)) } }
            catch (error: IOException) { online = false; local?.remote ?: EpisodeProgress(id) }
        ownerValid(owner)
        mutablePositions.value = mutablePositions.value + (id to remote)
        if (podcastSkipsCompleted(remote.completed, automatic, explicitRestart)) return PodcastPreparation.Completed
        val restart = podcastShouldRestart(remote.completed, automatic, explicitRestart, requestedMs, mode.value)
        val conflict = local?.conflictsWith(remote) == true
        val remoteMs = remote.positionSeconds * 1000L
        var position = requestedMs ?: if (online) remoteMs
            else if (local?.dirty == true && !conflict) local.update.positionSeconds * 1000L
            else if (remoteMs > 0L) remoteMs else (fallbackMs ?: 0L).coerceAtLeast(0L)
        var intent = if (restart) "restart" else "resume"
        if (restart && requestedMs == null) position = 0
        if (podcastShouldAskPosition(mode.value, requestedMs, automatic, restart, position, promptHosted)) {
            val response = CompletableDeferred<Boolean?>()
            answer?.complete(null); answer = response
            mutablePrompt.value = EpisodeProgressPrompt(title, position, position, false)
            val resume = try { response.await() } finally { if (answer === response) { answer = null; mutablePrompt.value = null } }
            if (resume == null) return null
            if (!resume) { position = 0; intent = "restart" }
        }
        mutableMessage.value = null
        val session = UUID.randomUUID().toString()
        val value = EpisodeCheckpoint(remote, PodcastProgressUpdate(session, device, remote.version, 1,
            (position / 1000).coerceAtLeast(0), (durationMs / 1000).coerceAtLeast(0), "play", intent))
        stateLock.withLock { ownerValid(owner); save(owner, id, value); active = Triple(owner, id, session); activeConflicted = false; mutableConflict.value = false }
        if (online) flush(owner, id)
        ownerValid(owner)
        return PodcastPreparation.Play(position)
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
                if (!activeConflicted && (force || android.os.SystemClock.elapsedRealtime() - (lastSent["${session.first}:$id"] ?: 0) >= 10_000)) flush(session.first, id)
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { pageProblem(R.string.pod_prog_sync_failed_check_network) }
        }
    }
    fun clearMessage() { mutableMessage.value = null }
    fun completed() { mutableMessage.value = AppLanguage.string(R.string.podcast_already_completed) }
    fun syncProblem() = pageProblem(R.string.pod_prog_sync_failed_check_network)
    fun playbackProblem() { mutableMessage.value = AppLanguage.string(R.string.pod_prog_load_failed_retry) }

    /** A failure the page must surface itself; informational messages stay in [message] only. */
    private fun pageProblem(resource: Int) {
        mutableMessage.value = AppLanguage.string(resource)
        mutablePageNotice.value = PodcastPageNotice(++pageNoticeRevision, AppLanguage.string(resource))
    }
    fun clearPageNotice() { mutablePageNotice.value = null }
    fun retry() { scope.launch { flushAll(throttle = true) } }
    private suspend fun flushAll(throttle: Boolean = false) {
        val owner = repository.session.cacheScope() ?: return
        for (row in repository.database.podcasts().all(storageOwner(owner))) {
            if (owner != repository.session.cacheScope()) return
            if (!throttle || android.os.SystemClock.elapsedRealtime() - (lastSent["$owner:${row.episodeId}"] ?: 0) >= 10_000) flush(owner, row.episodeId)
        }
    }
    private fun conflictCurrent(error: HttpException): EpisodeProgress? = runCatching {
        val body = com.google.gson.JsonParser.parseString(error.response()?.errorBody()?.string()).asJsonObject
        gson.fromJson(body.getAsJsonObject("detail").getAsJsonObject("current"), EpisodeProgress::class.java)
    }.getOrNull()

    private suspend fun flush(owner: String, id: String, retrySameDevice: Boolean = true) {
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
                // A successful write answers any earlier "sync failed" notice, on the page as well.
                mutableMessage.value = null
                mutablePageNotice.value = null
            } catch (error: CancellationException) { throw error }
            catch (error: HttpException) {
                if (owner != repository.session.cacheScope()) return@withLock
                if (error.code() == 409) {
                    val current = conflictCurrent(error) ?: try { request { repository.api().podcastProgress(id, RequestOwner(owner)) } }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { null }
                    val isActiveSession = active == Triple(owner, id, pending.update.sessionId)
                    // Without the server state there is nothing to adopt or rebase onto. Keep a historical
                    // record retryable instead of freezing it as a conflict the user never saw.
                    if (current == null) {
                        if (isActiveSession) markConflict(owner, id, pending.update.sessionId)
                        return@withLock
                    }
                    if (!isActiveSession) {
                        stateLock.withLock {
                            ownerValid(owner)
                            val latest = read(owner, id)?.takeIf { it.update.sessionId == pending.update.sessionId } ?: return@withLock
                            save(owner, id, latest.copy(remote = current, dirty = false, conflict = false))
                            mutablePositions.value = mutablePositions.value + (id to current)
                        }
                    } else if (retrySameDevice && current.deviceId == device) {
                        val rebased = stateLock.withLock {
                            val latest = read(owner, id)?.takeIf { it.update.sessionId == pending.update.sessionId } ?: return@withLock null
                            latest.copy(remote = current, update = latest.update.copy(baseVersion = current.version)).also { save(owner, id, it) }
                        }
                        if (rebased != null) {
                            try {
                                val remote = request { repository.api().updatePodcastProgress(id, pending.update.copy(baseVersion = current.version), RequestOwner(owner)) }
                                stateLock.withLock {
                                    ownerValid(owner)
                                    val latest = read(owner, id) ?: return@withLock
                                    save(owner, id, latest.acknowledged(pending.update, remote))
                                    if (latest.update.sessionId == rebased.update.sessionId) mutablePositions.value = mutablePositions.value + (id to remote)
                                }
                            } catch (retryError: CancellationException) { throw retryError }
                            catch (retryError: HttpException) {
                                if (retryError.code() == 409) markConflict(owner, id, pending.update.sessionId, conflictCurrent(retryError))
                            }
                        }
                    } else markConflict(owner, id, pending.update.sessionId, current)
                } else if (error.code() == 422) pageProblem(R.string.pod_prog_server_update_required)
            } catch (_: IOException) { /* Persisted outbox is retried; never turn a retry into a new claim. */ }
        }
    }
    private suspend fun markConflict(owner: String, id: String, session: String, current: EpisodeProgress? = null) {
        stateLock.withLock {
            val latest = read(owner, id)?.takeIf { it.update.sessionId == session } ?: return@withLock
            save(owner, id, latest.copy(remote = current ?: latest.remote, conflict = true))
            if (active == Triple(owner, id, session)) { activeConflicted = true; mutableConflict.value = true }
        }
    }

    fun useLocalProgress() {
        val session = active ?: return
        scope.launch {
            val current = try { request { repository.api().podcastProgress(session.second, RequestOwner(session.first)) } }
                catch (error: CancellationException) { throw error }
                catch (_: Exception) { mutableMessage.value = AppLanguage.string(R.string.pod_prog_sync_failed_check_network); return@launch }
            stateLock.withLock {
                val latest = read(session.first, session.second)?.takeIf { it.update.sessionId == session.third && it.conflict } ?: return@launch
                val nextSession = UUID.randomUUID().toString()
                val update = latest.update.copy(sessionId = nextSession, baseVersion = current.version, sequence = 1, intent = "resume")
                save(session.first, session.second, latest.copy(remote = current, update = update, dirty = true, conflict = false))
                active = Triple(session.first, session.second, nextSession)
                activeConflicted = false
            }
            flush(session.first, session.second, retrySameDevice = false)
            val claimed = stateLock.withLock {
                val current = active ?: return@withLock false
                read(current.first, current.second)?.remote?.sessionId == current.third
            }
            if (claimed && !activeConflicted) mutableConflict.value = false
            else active?.let { markConflict(it.first, it.second, it.third) }
        }
    }

}
