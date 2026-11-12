package com.wildstring.app.ui

import android.content.Context
import androidx.media3.common.Player
import com.wildstring.app.R
import com.wildstring.app.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class PodcastQueueRow(
    val episodeId: String,
    val podcastId: String,
    val title: String,
    val showTitle: String,
    val addedAt: String = "",
    val unavailable: Boolean = false,
    val origin: String = "manual",
)

/** Where the user started playback. Prev/next and the episode after this one stay inside it. */
internal enum class PodcastPlaybackContext { SHOW, QUEUE }

data class PodcastAutoPreviewItem(
    val episodeId: String,
    val podcastId: String,
    val title: String,
    val showTitle: String,
    val durationSeconds: Int = 0,
    val episode: PodcastEpisode,
    val summary: PodcastSummary,
)

data class PodcastQueueConflictState(
    val localItems: List<PodcastQueueItem>,
    val serverVersion: Int,
    val serverItems: List<PodcastQueueItem>,
)

data class PodcastCloudState(
    val queueLoading: Boolean = false,
    val preferencesLoading: Boolean = false,
    val queueError: String? = null,
    val preferencesError: String? = null,
    val syncError: String? = null,
    val notice: String? = null,
    val queueFull: Boolean = false,
    val queue: List<PodcastQueueItem> = emptyList(),
    val queueRows: List<PodcastQueueRow> = emptyList(),
    val autoPreview: List<PodcastAutoPreviewItem> = emptyList(),
    val preferences: PodcastQueuePreferences? = null,
    val conflict: PodcastQueueConflictState? = null,
)

/**
 * Cloud queue and preferences. Show playback never rewrites the queue.
 * Manual queue edits do not start audio and do not replace the loaded episode.
 * Auto-continue is a local preview and is never uploaded.
 */
class PodcastQueueController(
    private val repository: Repository,
    private val settings: AppSettings,
    private val context: Context,
    private val scope: CoroutineScope,
    private val deviceId: () -> String,
    private val player: () -> Player?,
    private val prepareAdvance: () -> Unit,
    private val play: (tracks: List<Track>, index: Int, positionMs: Long?, autoplay: Boolean) -> Unit,
    private val requireOwner: (String?) -> Unit,
    private val positions: () -> Map<String, EpisodeProgress>,
) {
    private val mutex = Mutex()
    private val mutable = MutableStateFlow(PodcastCloudState())
    val state: StateFlow<PodcastCloudState> = mutable.asStateFlow()
    private var snapshot = PodcastQueueSnapshot()
    private var loaded = false
    private var diverged = false
    private var preferences = PodcastQueuePreferences()
    private var preferencesLoaded = false
    private var preferenceWrite = 0
    private var retry: (suspend () -> Unit)? = null
    private var lastFinishedEpisode: String? = null
    private var lastFinishedAt = 0L
    private var playbackContext = PodcastPlaybackContext.SHOW

    fun refresh() = scope.launch { refreshNow() }

    fun refreshPreferences() = scope.launch {
        val stamp = preferenceWrite
        try {
            val saved = repository.podcastQueuePreferences()
            mutex.withLock { if (stamp == preferenceWrite) applyPreferences(saved) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            mutable.update { it.copy(preferencesError = podcastListFailure(friendlyError(error))) }
        }
    }

    fun playEpisode(episode: PodcastEpisode, podcast: PodcastSummary, positionMs: Long?) = scope.launch {
        try { playShowNow(episode, podcast, positionMs) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { mutable.update { it.copy(notice = friendlyError(error)) } }
    }

    fun playFromQueue(startEpisodeId: String?) = scope.launch {
        try { playQueueNow(startEpisodeId) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { mutable.update { it.copy(notice = friendlyError(error)) } }
    }

    fun followsQueue(): Boolean = playbackContext == PodcastPlaybackContext.QUEUE

    fun enqueue(episode: PodcastEpisode, next: Boolean) = scope.launch {
        try { enqueueNow(episode.id, next) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { mutable.update { it.copy(queueError = podcastListFailure(friendlyError(error))) } }
    }

    /** Dragging rewrites the list and marks every moved row manual, including a former rule row. */
    fun reorderPending(rows: List<PodcastQueueRow>) = scope.launch {
        val items = rows.map { PodcastQueueItem(episodeId = it.episodeId, origin = "manual", addedAt = it.addedAt) }
        mutable.update { it.copy(queue = items, queueRows = rows.map { row -> row.copy(origin = "manual") }) }
        val saved = mutex.withLock { pushOrKeep(items) }
        if (saved && playbackContext == PodcastPlaybackContext.QUEUE) syncQueuePlayer(items)
    }

    fun removeQueued(episodeId: String) = scope.launch {
        if (episodeId == playingEpisodeId()) return@launch
        val items = mutex.withLock {
            val next = podcastQueueRemoveEpisode(snapshot.items, episodeId)
            snapshot = snapshot.copy(items = next)
            mutable.update { it.copy(queue = next, queueRows = it.queueRows.filter { row -> row.episodeId != episodeId }) }
            pushOrKeep(next)
            snapshot.items
        }
        if (playbackContext == PodcastPlaybackContext.QUEUE) syncQueuePlayer(items)
    }

    fun restoreQueued(row: PodcastQueueRow, index: Int) = scope.launch {
        val items = mutex.withLock {
            if (snapshot.items.any { it.episodeId == row.episodeId }) snapshot.items
            else {
                val placed = podcastQueuePlace(snapshot.items, row.episodeId, index)
                if (placed.atLimit) {
                    mutable.update { it.copy(notice = context.getString(R.string.podcast_queue_limit)) }
                    snapshot.items
                } else {
                    val edited = placed.items.map { item ->
                        if (item.episodeId == row.episodeId) item.copy(origin = if (row.origin == "rule") "rule" else "manual", addedAt = row.addedAt) else item
                    }
                    snapshot = snapshot.copy(items = edited)
                    mutable.update { state ->
                        val rows = state.queueRows.toMutableList()
                        if (rows.none { it.episodeId == row.episodeId }) rows.add(index.coerceIn(0, rows.size), row)
                        state.copy(queue = edited, queueRows = rows)
                    }
                    pushOrKeep(edited)
                    snapshot.items
                }
            }
        }
        if (playbackContext == PodcastPlaybackContext.QUEUE) syncQueuePlayer(items)
    }

    fun updateShow(podcastId: String, action: String, autoLimit: Int = 3) = scope.launch {
        val normalized = normalizeDeliveryAction(action)
        if (normalized !in SHOW_ACTIONS || autoLimit !in 0..100) return@launch
        preferenceWrite += 1
        retry = { updateShowNow(podcastId, normalized, autoLimit) }
        updateShowNow(podcastId, normalized, autoLimit)
    }

    fun updateAutoContinue(enabled: Boolean) = scope.launch {
        settings.podcastContinuePreference(settings.podcastContinuePreference().copy(autoContinue = enabled))
        preferenceWrite += 1
        mutex.withLock {
            val next = if (preferencesLoaded) podcastPreferencesUpdatingAutoContinue(preferences, enabled) else preferences.copy(autoContinue = enabled)
            applyPreferences(next)
        }
        retry = { updateAutoContinueNow(enabled) }
        updateAutoContinueNow(enabled)
    }

    fun retry() = scope.launch {
        val action = retry
        if (action != null) action()
        else if (mutable.value.conflict != null) refreshNow()
    }

    fun resolveConflict(choice: PodcastQueueConflictChoice) = scope.launch {
        val conflict = mutable.value.conflict ?: return@launch
        val decision = resolvePodcastQueueConflict(conflict.localItems, conflict.serverVersion, conflict.serverItems, choice)
        if (!decision.upload) {
            mutex.withLock {
                snapshot = PodcastQueueSnapshot(version = decision.version, deviceId = deviceId(), items = decision.items)
                loaded = true
                diverged = choice == PodcastQueueConflictChoice.KEEP_LOCAL
                mutable.update { it.copy(queue = decision.items, conflict = if (diverged) conflict else null, syncError = null) }
            }
            if (choice == PodcastQueueConflictChoice.USE_SERVER && playbackContext == PodcastPlaybackContext.QUEUE) syncQueuePlayer(decision.items)
            publishQueueRows(decision.items)
            return@launch
        }
        val uploaded = mutex.withLock {
            snapshot = snapshot.copy(version = decision.version, items = decision.items)
            loaded = true
            diverged = false
            pushOrKeep(decision.items)
        }
        if (uploaded && playbackContext == PodcastPlaybackContext.QUEUE) syncQueuePlayer(decision.items)
    }

    fun onEpisodeFinished(episodeId: String, advanceLocally: Boolean) {
        val now = android.os.SystemClock.elapsedRealtime()
        if (lastFinishedEpisode == episodeId && now - lastFinishedAt < 1500) return
        lastFinishedEpisode = episodeId
        lastFinishedAt = now
        scope.launch {
            try { finishNow(episodeId, advanceLocally) }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { /* Playback already moved on; the queue banner keeps the sync error. */ }
        }
    }

    fun preferenceFor(podcastId: String?): PodcastContinuePreference = podcastContinuePreferenceFor(
        if (preferencesLoaded) preferences else mutable.value.preferences,
        podcastId,
        settings.podcastContinuePreference(),
    )

    fun clearNotice() { mutable.update { it.copy(notice = null) } }

    fun reset() {
        snapshot = PodcastQueueSnapshot()
        loaded = false
        diverged = false
        preferences = PodcastQueuePreferences()
        preferencesLoaded = false
        playbackContext = PodcastPlaybackContext.SHOW
        retry = null
        mutable.value = PodcastCloudState()
    }

    private suspend fun refreshNow() {
        mutable.update {
            it.copy(
                queueLoading = it.queueRows.isEmpty() && !diverged,
                preferencesLoading = it.preferences == null,
                queueError = if (diverged) it.queueError else null,
            )
        }
        val queueResult = runCatching { repository.podcastQueue() }
        val prefResult = runCatching { repository.podcastQueuePreferences() }
        val queueItems = mutex.withLock {
            queueResult.onSuccess { remote ->
                mutable.update { it.copy(queueFull = remote.notice == "queue_full") }
                if (!diverged) {
                    snapshot = remote
                    loaded = true
                    mutable.update { it.copy(queue = remote.items, queueError = null, queueFull = remote.notice == "queue_full") }
                }
            }.onFailure { error ->
                if (error is CancellationException) throw error
                if (error !is retrofit2.HttpException || error.code() !in listOf(404, 405)) {
                    mutable.update { it.copy(queueError = podcastListFailure(friendlyError(error))) }
                }
            }
            prefResult.onSuccess { applyPreferences(it) }.onFailure { error ->
                if (error is CancellationException) throw error
                if (error !is retrofit2.HttpException || error.code() !in listOf(404, 405)) {
                    mutable.update { it.copy(preferencesError = podcastListFailure(friendlyError(error))) }
                }
            }
            mutable.update { it.copy(queueLoading = false, preferencesLoading = false) }
            snapshot.items
        }
        if (!diverged && queueResult.isSuccess) publishQueueRows(queueItems)
    }

    /** Show, episode, search, and favorites. Does not rewrite the cloud queue. */
    private suspend fun playShowNow(episode: PodcastEpisode, podcast: PodcastSummary, positionMs: Long?) {
        playbackContext = PodcastPlaybackContext.SHOW
        if (player() == null) {
            mutable.update { it.copy(notice = context.getString(R.string.podcast_player_preparing)) }
            return
        }
        val detail = repository.cachedPodcastDetail(podcast.id) ?: runCatching { repository.podcastDetail(podcast.id) }.getOrNull()
        val lineup = if (detail == null) listOf(episode) else podcastShowLineup(episode, detail, preferenceFor(podcast.id), positions())
        val summary = detail?.podcast ?: podcast
        val tracks = lineup.map { item -> repository.rememberPodcastEpisode(if (item.id == episode.id) episode else item, summary) }
        prepareAdvance()
        val index = tracks.indexOfFirst { podcastEpisodeId(it.id) == episode.id }.coerceAtLeast(0)
        play(tracks.ifEmpty { listOf(repository.rememberPodcastEpisode(episode, summary)) }, index, positionMs, true)
    }

    /** Pending list and play-all. Starts at [startEpisodeId] when that episode is queued. */
    private suspend fun playQueueNow(startEpisodeId: String?) {
        playbackContext = PodcastPlaybackContext.QUEUE
        if (player() == null) {
            mutable.update { it.copy(notice = context.getString(R.string.podcast_player_preparing)) }
            return
        }
        val items = mutex.withLock {
            if (!loaded && !diverged) {
                runCatching { repository.podcastQueue() }.onSuccess { remote ->
                    snapshot = remote
                    loaded = true
                    mutable.update { it.copy(queue = remote.items, queueError = null, queueFull = remote.notice == "queue_full") }
                }
            }
            snapshot.items
        }
        if (items.isEmpty()) return
        val start = startEpisodeId?.let { id -> items.indexOfFirst { it.episodeId == id }.takeIf { it >= 0 } } ?: 0
        val anchorItem = items[start]
        val anchorEpisode = repository.cachedPodcastEpisode(anchorItem.episodeId) ?: runCatching { repository.podcastEpisode(anchorItem.episodeId) }.getOrNull()
        val anchorSummary = anchorEpisode?.let { episode ->
            repository.cachedPodcastDetail(episode.podcastId)?.podcast
                ?: runCatching { repository.podcastDetail(episode.podcastId).podcast }.getOrNull()
                ?: PodcastSummary(episode.podcastId, episode.title, feedUrl = "")
        }
        val anchor = if (anchorEpisode != null && anchorSummary != null) anchorEpisode to anchorSummary else null
        val tracks = resolveTracks(items, anchor)
        if (tracks.isEmpty()) return
        val index = tracks.indexOfFirst { podcastEpisodeId(it.id) == anchorItem.episodeId }.coerceAtLeast(0)
        prepareAdvance()
        play(tracks, index, null, true)
    }

    private suspend fun enqueueNow(episodeId: String, next: Boolean) {
        val playing = playingEpisodeId()
        if (next && playing != null && playing == episodeId) return
        val after = playing?.takeIf { next }
        val outcome = mutex.withLock {
            val prepared = placeEnqueue(episodeId, next, after, playing)
            when {
                prepared.atLimit -> "limit"
                !prepared.changed -> "unchanged"
                !prepared.remoteRead -> {
                    failSync(prepared.failure, snapshot.items)
                    retry = { enqueueNow(episodeId, next) }
                    "failed"
                }
                !pushOrKeep(prepared.items) -> {
                    retry = { enqueueNow(episodeId, next) }
                    "failed"
                }
                else -> "saved"
            }
        }
        when (outcome) {
            "limit" -> mutable.update { it.copy(notice = context.getString(R.string.podcast_queue_limit)) }
            "saved" -> {
                val items = mutex.withLock { snapshot.items }
                if (playbackContext == PodcastPlaybackContext.QUEUE) syncQueuePlayer(items)
                mutable.update { it.copy(notice = context.getString(R.string.podcast_added_queue), queueError = null, syncError = null) }
                publishQueueRows(items)
            }
        }
    }

    private suspend fun finishNow(episodeId: String, advanceLocally: Boolean) {
        val owner = repository.session.cacheScope()
        val wasQueued = mutex.withLock { snapshot.items.any { it.episodeId == episodeId } }
        if (!advanceLocally && playbackContext == PodcastPlaybackContext.QUEUE) removePlayedMediaItem(episodeId)
        if (wasQueued) {
            mutex.withLock {
                val next = podcastQueueRemoveEpisode(snapshot.items, episodeId)
                pushOrKeep(next)
            }
        }
        if (!advanceLocally || playbackContext == PodcastPlaybackContext.QUEUE) return
        if (!preferencesLoaded) {
            runCatching { repository.podcastQueuePreferences() }.onSuccess {
                mutex.withLock { applyPreferences(it) }
            }
        }
        val episode = repository.cachedPodcastEpisode(episodeId) ?: runCatching { repository.podcastEpisode(episodeId) }.getOrNull() ?: return
        val detail = repository.cachedPodcastDetail(episode.podcastId) ?: runCatching { repository.podcastDetail(episode.podcastId) }.getOrNull() ?: return
        requireOwner(owner)
        val plan = podcastEndPlan(false, episode, detail, positions(), preferenceFor(episode.podcastId))
        if (plan.action != PodcastEndAction.CONTINUE) return
        val next = plan.episode ?: return
        check(podcastQueueAutoContinue(next.id) == listOf(next.id))
        requireOwner(owner)
        playShowNow(next, detail.podcast, null)
    }

    private suspend fun updateShowNow(podcastId: String, action: String, autoLimit: Int) {
        try {
            val saved = mutex.withLock {
                val current = repository.podcastQueuePreferences()
                val existing = current.shows.orEmpty()[podcastId]
                val base = existing ?: PodcastShowQueuePreference(
                    action = current.defaultAction,
                    autoLimit = current.autoLimit,
                    autoContinue = current.autoContinue,
                )
                val next = podcastPreferencesUpdatingShow(current, podcastId, base.copy(action = action, autoLimit = autoLimit))
                repository.savePodcastQueuePreferences(next)
            }
            mutex.withLock { applyPreferences(saved) }
            mutable.update { it.copy(preferencesError = null, notice = context.getString(R.string.podcast_show_pref_saved)) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            mutable.update { it.copy(preferencesError = context.getString(R.string.podcast_preferences_failed) + "\n" + friendlyError(error)) }
        }
    }

    private suspend fun updateAutoContinueNow(enabled: Boolean) {
        try {
            val saved = mutex.withLock {
                val current = repository.podcastQueuePreferences()
                repository.savePodcastQueuePreferences(podcastPreferencesUpdatingAutoContinue(current, enabled))
            }
            mutex.withLock { applyPreferences(saved) }
            settings.podcastContinuePreference(settings.podcastContinuePreference().copy(autoContinue = saved.autoContinue))
            mutable.update { it.copy(preferencesError = null) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            mutable.update { it.copy(preferencesError = podcastListFailure(friendlyError(error))) }
        }
    }

    private data class Placed(
        val items: List<PodcastQueueItem>,
        val remoteRead: Boolean,
        val atLimit: Boolean,
        val failure: Throwable?,
        val changed: Boolean,
    )

    private suspend fun placeEnqueue(episodeId: String, next: Boolean, after: String?, currentEpisodeId: String?): Placed {
        if (diverged) {
            val placement = podcastQueueEnqueue(snapshot.items, episodeId, next, after, currentEpisodeId)
            val changed = placement.items != snapshot.items
            if (changed) {
                snapshot = snapshot.copy(items = placement.items)
                mutable.update { it.copy(queue = placement.items) }
            }
            return Placed(placement.items, remoteRead = true, atLimit = placement.atLimit, failure = null, changed = changed)
        }
        return try {
            val remote = repository.podcastQueue()
            snapshot = remote
            loaded = true
            mutable.update { it.copy(queue = remote.items, queueFull = remote.notice == "queue_full") }
            val placement = podcastQueueEnqueue(remote.items, episodeId, next, after, currentEpisodeId)
            val changed = placement.items != remote.items
            if (changed) {
                snapshot = snapshot.copy(items = placement.items)
                mutable.update { it.copy(queue = placement.items) }
            }
            Placed(placement.items, remoteRead = true, atLimit = placement.atLimit, failure = null, changed = changed)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            Placed(snapshot.items, remoteRead = false, atLimit = false, failure = error, changed = false)
        }
    }

    /** Caller already holds [mutex]. A 409 keeps [items] and opens the conflict choice. */
    private suspend fun pushOrKeep(items: List<PodcastQueueItem>): Boolean {
        if (!loaded) {
            val remote = try { repository.podcastQueue() } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                failSync(error, items)
                return false
            }
            snapshot = remote
            loaded = true
        }
        if (diverged) {
            mutable.update { state ->
                val conflict = state.conflict ?: PodcastQueueConflictState(items, snapshot.version, snapshot.items)
                state.copy(queue = items, conflict = conflict.copy(localItems = items))
            }
            snapshot = snapshot.copy(items = items)
            return false
        }
        return try {
            val saved = repository.replacePodcastQueue(snapshot.version, deviceId(), items)
            snapshot = saved.copy(deviceId = saved.deviceId.ifBlank { deviceId() })
            loaded = true
            diverged = false
            mutable.update { it.copy(queue = snapshot.items, syncError = null, conflict = null, queueError = null, queueFull = saved.notice == "queue_full") }
            publishQueueRows(snapshot.items)
            true
        } catch (error: PodcastQueueConflictException) {
            diverged = true
            snapshot = snapshot.copy(items = items)
            mutable.update {
                it.copy(queue = items, syncError = null, conflict = PodcastQueueConflictState(items, error.current.version, error.current.items))
            }
            false
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            failSync(error, items)
            false
        }
    }

    private fun failSync(error: Throwable?, items: List<PodcastQueueItem>) {
        snapshot = snapshot.copy(items = items)
        if (error is retrofit2.HttpException && error.code() in listOf(404, 405)) {
            mutable.update { it.copy(queue = items, syncError = null) }
            return
        }
        val reason = error?.let { friendlyError(it) }.orEmpty()
        val message = podcastSyncFailureMessage(reason, context.getString(R.string.podcast_sync_failed))
        mutable.update { it.copy(queue = items, syncError = message) }
    }

    private fun applyPreferences(saved: PodcastQueuePreferences) {
        preferences = saved.forUpload()
        preferencesLoaded = true
        settings.podcastContinuePreference(settings.podcastContinuePreference().copy(autoContinue = preferences.autoContinue))
        mutable.update { it.copy(preferences = preferences, preferencesLoading = false, preferencesError = null) }
    }

    private suspend fun publishQueueRows(items: List<PodcastQueueItem>) {
        val described = describe(items.map { Triple(it.episodeId, "", if (it.addedAt.isNullOrBlank()) "" else it.addedAt) })
        val rows = described.mapIndexed { index, row ->
            val origin = items.getOrNull(index)?.origin
            row.copy(origin = if (origin == "rule") "rule" else "manual")
        }
        val preview = computeAutoPreview()
        mutable.update { it.copy(queueRows = rows, queueLoading = false, autoPreview = preview) }
    }

    fun refreshAutoPreview() = scope.launch {
        val preview = computeAutoPreview()
        mutable.update { it.copy(autoPreview = preview) }
    }

    /** Show-line lookahead from the episode that is actually playing. The queue does not choose the show. */
    private suspend fun computeAutoPreview(): List<PodcastAutoPreviewItem> {
        val currentEpId = playingEpisodeId() ?: return emptyList()
        val anchorEpisode = repository.cachedPodcastEpisode(currentEpId) ?: runCatching { repository.podcastEpisode(currentEpId) }.getOrNull() ?: return emptyList()
        val detail = repository.cachedPodcastDetail(anchorEpisode.podcastId) ?: runCatching { repository.podcastDetail(anchorEpisode.podcastId) }.getOrNull() ?: return emptyList()
        val pref = preferenceFor(anchorEpisode.podcastId)
        if (!pref.enabled) return emptyList()

        val previewList = mutableListOf<PodcastAutoPreviewItem>()
        var currentAnchor = anchorEpisode
        var remaining = 3
        while (remaining > 0) {
            remaining -= 1
            val next = nextEpisode(currentAnchor, detail, positions(), pref) ?: break
            if (previewList.none { it.episodeId == next.id }) {
                previewList.add(
                    PodcastAutoPreviewItem(
                        episodeId = next.id,
                        podcastId = next.podcastId,
                        title = next.title,
                        showTitle = detail.podcast.title,
                        durationSeconds = next.durationSeconds,
                        episode = next,
                        summary = detail.podcast,
                    )
                )
            }
            currentAnchor = next
        }
        return previewList
    }

    private suspend fun describe(pairs: List<Triple<String, String, String>>): List<PodcastQueueRow> {
        val rows = mutableListOf<PodcastQueueRow>()
        for (chunk in pairs.chunked(6)) {
            rows += coroutineScope {
                chunk.map { (episodeId, podcastId, addedAt) ->
                    async {
                        val episode = repository.cachedPodcastEpisode(episodeId) ?: runCatching { repository.podcastEpisode(episodeId) }.getOrNull()
                        val fallback = context.getString(R.string.podcast_queue_row_unavailable)
                        if (episode == null) return@async PodcastQueueRow(episodeId, podcastId, fallback, "", addedAt, unavailable = true)
                        val show = repository.cachedPodcastDetail(episode.podcastId)?.podcast?.title
                            ?: runCatching { repository.podcastDetail(episode.podcastId).podcast.title }.getOrNull().orEmpty()
                        PodcastQueueRow(episode.id, episode.podcastId, episode.title.ifBlank { fallback }, show, addedAt)
                    }
                }.awaitAll()
            }
        }
        return rows
    }

    private suspend fun resolveTracks(items: List<PodcastQueueItem>, anchor: Pair<PodcastEpisode, PodcastSummary>?): List<Track> {
        val tracks = mutableListOf<Track>()
        var missing = 0
        for (item in items) {
            if (anchor != null && item.episodeId == anchor.first.id) {
                tracks += repository.rememberPodcastEpisode(anchor.first, anchor.second)
                continue
            }
            val episode = repository.cachedPodcastEpisode(item.episodeId) ?: runCatching { repository.podcastEpisode(item.episodeId) }.getOrNull()
            if (episode == null) { missing += 1; continue }
            val summary = repository.cachedPodcastDetail(episode.podcastId)?.podcast
                ?: runCatching { repository.podcastDetail(episode.podcastId).podcast }.getOrNull()
                ?: PodcastSummary(episode.podcastId, episode.title, feedUrl = "")
            tracks += repository.rememberPodcastEpisode(episode, summary)
        }
        if (missing > 0) mutable.update { it.copy(notice = context.getString(R.string.podcast_episode_unavailable)) }
        return tracks
    }

    /** Queue context only. Keeps the loaded episode and does not start a stopped player. */
    private suspend fun syncQueuePlayer(items: List<PodcastQueueItem>) {
        if (playbackContext != PodcastPlaybackContext.QUEUE) return
        val current = playingEpisodeId() ?: return
        if (items.none { it.episodeId == current }) return
        val tracks = resolveTracks(items, null)
        val index = tracks.indexOfFirst { podcastEpisodeId(it.id) == current }
        val c = player() ?: return
        if (index < 0) return
        prepareAdvance()
        play(tracks, index, c.currentPosition.coerceAtLeast(0), c.playWhenReady)
    }

    private fun removePlayedMediaItem(episodeId: String) {
        val c = player() ?: return
        val index = (0 until c.mediaItemCount).firstOrNull { i ->
            podcastEpisodeId(c.getMediaItemAt(i).mediaMetadata.extras?.getString("track_id")) == episodeId && i != c.currentMediaItemIndex
        } ?: return
        c.removeMediaItem(index)
    }

    private fun playingEpisodeId(): String? =
        podcastEpisodeId(player()?.currentMediaItem?.mediaMetadata?.extras?.getString("track_id"))

    private companion object {
        val SHOW_ACTIONS = setOf("queue_last", "queue_next", "ignore")
    }
}
