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
)

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
    val inboxLoading: Boolean = false,
    val queueLoading: Boolean = false,
    val preferencesLoading: Boolean = false,
    val inboxError: String? = null,
    val queueError: String? = null,
    val preferencesError: String? = null,
    val syncError: String? = null,
    val notice: String? = null,
    val inbox: List<PodcastInboxItem> = emptyList(),
    val inboxRows: List<PodcastQueueRow> = emptyList(),
    val queue: List<PodcastQueueItem> = emptyList(),
    val queueRows: List<PodcastQueueRow> = emptyList(),
    val autoPreview: List<PodcastAutoPreviewItem> = emptyList(),
    val preferences: PodcastQueuePreferences? = null,
    val conflict: PodcastQueueConflictState? = null,
)

/**
 * Cloud inbox, queue and preferences. Media3 is updated to the queue only while a podcast
 * is already playing, or when the user starts an episode. Auto-continue is never uploaded.
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
    private var inbox = emptyList<PodcastInboxItem>()

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
        try { playEpisodeNow(episode, podcast, positionMs) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { mutable.update { it.copy(notice = friendlyError(error)) } }
    }

    fun enqueue(episode: PodcastEpisode, next: Boolean) = scope.launch {
        try { enqueueNow(episode.id, next, dropInbox = true) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { mutable.update { it.copy(queueError = podcastListFailure(friendlyError(error))) } }
    }

    fun addInbox(episode: PodcastEpisode) = scope.launch {
        try {
            repository.addPodcastInbox(episode.id)
            refreshInbox()
            mutable.update { it.copy(notice = context.getString(R.string.podcast_added_inbox), inboxError = null) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { mutable.update { it.copy(inboxError = podcastListFailure(friendlyError(error))) } }
    }

    fun removeInbox(episodeId: String) = scope.launch {
        try {
            repository.removePodcastInbox(episodeId)
            inbox = podcastInboxWithout(inbox, episodeId)
            publishInbox(inbox)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { mutable.update { it.copy(inboxError = podcastListFailure(friendlyError(error))) } }
    }

    /** Rewrites the whole pending list in the given order; queued rows win over the inbox copy. */
    fun reorderPending(rows: List<PodcastQueueRow>) = scope.launch {
        val ids = rows.map { it.episodeId }.toSet()
        val items = rows.map { PodcastQueueItem(episodeId = it.episodeId, origin = "manual", addedAt = it.addedAt) }
        mutable.update { state ->
            state.copy(
                queue = items,
                queueRows = rows,
                inboxRows = state.inboxRows.filterNot { it.episodeId in ids },
            )
        }
        val saved = mutex.withLock { pushOrKeep(items) }
        if (saved) {
            inbox = inbox.filterNot { it.episodeId in ids }
            mutable.update { state ->
                state.copy(
                    inbox = inbox,
                    inboxRows = state.inboxRows.filterNot { it.episodeId in ids },
                )
            }
            alignPlayer(items)
        }
    }

    fun removeQueued(episodeId: String) = scope.launch {
        val items = mutex.withLock {
            val next = podcastQueueRemoveEpisode(snapshot.items, episodeId)
            pushOrKeep(next)
            snapshot.items
        }
        alignPlayer(items)
    }

    fun moveInboxToQueue(episodeId: String) = scope.launch {
        try { enqueueNow(episodeId, next = false, dropInbox = true) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { mutable.update { it.copy(queueError = podcastListFailure(friendlyError(error))) } }
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
            if (choice == PodcastQueueConflictChoice.USE_SERVER) alignPlayer(decision.items)
            publishQueueRows(decision.items)
            return@launch
        }
        val uploaded = mutex.withLock {
            snapshot = snapshot.copy(version = decision.version, items = decision.items)
            loaded = true
            diverged = false
            pushOrKeep(decision.items)
        }
        if (uploaded) alignPlayer(decision.items)
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
        inbox = emptyList()
        retry = null
        mutable.value = PodcastCloudState()
    }

    private suspend fun refreshNow() {
        mutable.update {
            it.copy(
                inboxLoading = it.inboxRows.isEmpty(),
                queueLoading = it.queueRows.isEmpty() && !diverged,
                preferencesLoading = it.preferences == null,
                inboxError = null,
                queueError = if (diverged) it.queueError else null,
            )
        }
        val inboxResult = runCatching { repository.podcastInbox() }
        val queueResult = runCatching { repository.podcastQueue() }
        val prefResult = runCatching { repository.podcastQueuePreferences() }
        val queueItems = mutex.withLock {
            inboxResult.onSuccess { inbox = it.items }.onFailure { error ->
                if (error is CancellationException) throw error
                if (error !is retrofit2.HttpException || error.code() !in listOf(404, 405)) {
                    mutable.update { it.copy(inboxError = podcastListFailure(friendlyError(error))) }
                }
            }
            queueResult.onSuccess { remote ->
                if (!diverged) {
                    snapshot = remote
                    loaded = true
                    mutable.update { it.copy(queue = remote.items, queueError = null) }
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
            mutable.update { it.copy(inboxLoading = false, queueLoading = false, preferencesLoading = false) }
            snapshot.items
        }
        publishInbox(inboxResult.getOrNull()?.items ?: inbox)
        if (!diverged && queueResult.isSuccess) publishQueueRows(queueItems)
    }

    private suspend fun playEpisodeNow(episode: PodcastEpisode, podcast: PodcastSummary, positionMs: Long?) {
        if (player() == null) {
            mutable.update { it.copy(notice = context.getString(R.string.podcast_player_preparing)) }
            return
        }
        val anchor = episode to podcast
        var queued = listOf(PodcastQueueItem(episode.id, "manual"))
        var dropInbox = false
        mutex.withLock {
            val prepared = placeOnCurrent(episode.id, 0)
            val blocked = prepared.atLimit && prepared.items.none { it.episodeId == episode.id }
            queued = if (blocked) listOf(PodcastQueueItem(episode.id, "manual")) else prepared.items
            if (blocked) {
                mutable.update { it.copy(notice = context.getString(R.string.podcast_queue_limit)) }
            } else if (!prepared.remoteRead) {
                failSync(prepared.failure, prepared.items)
                retry = { playEpisodeNow(episode, podcast, positionMs) }
            } else if (pushOrKeep(prepared.items)) {
                dropInbox = true
                retry = { mutex.withLock { pushOrKeep(snapshot.items) } }
            } else {
                retry = { playEpisodeNow(episode, podcast, positionMs) }
            }
        }
        val tracks = resolveTracks(queued, anchor)
        prepareAdvance()
        play(tracks.ifEmpty { listOf(repository.rememberPodcastEpisode(episode, podcast)) }, 0, positionMs, true)
        if (dropInbox) dropInboxAfterQueue(episode.id)
    }

    private suspend fun enqueueNow(episodeId: String, next: Boolean, dropInbox: Boolean) {
        val after = playingEpisodeId()?.takeIf { next }
        val outcome = mutex.withLock {
            val prepared = placeEnqueue(episodeId, next, after)
            when {
                prepared.atLimit -> "limit"
                !prepared.remoteRead -> {
                    failSync(prepared.failure, snapshot.items)
                    retry = { enqueueNow(episodeId, next, dropInbox) }
                    "failed"
                }
                !pushOrKeep(prepared.items) -> {
                    retry = { enqueueNow(episodeId, next, dropInbox) }
                    "failed"
                }
                else -> "saved"
            }
        }
        when (outcome) {
            "limit" -> mutable.update { it.copy(notice = context.getString(R.string.podcast_queue_limit)) }
            "saved" -> {
                if (dropInbox) dropInboxAfterQueue(episodeId)
                val items = mutex.withLock { snapshot.items }
                if (playingEpisodeId() != null) alignPlayer(items)
                mutable.update { it.copy(notice = context.getString(R.string.podcast_added_queue), queueError = null, syncError = null) }
                publishQueueRows(items)
            }
        }
    }

    private suspend fun finishNow(episodeId: String, advanceLocally: Boolean) {
        val owner = repository.session.cacheScope()
        val episode = repository.cachedPodcastEpisode(episodeId) ?: runCatching { repository.podcastEpisode(episodeId) }.getOrNull()
        val detail = episode?.let { repository.cachedPodcastDetail(it.podcastId) ?: runCatching { repository.podcastDetail(it.podcastId) }.getOrNull() }
        requireOwner(owner)
        if (!advanceLocally) removePlayedMediaItem(episodeId)
        val remaining = mutex.withLock {
            val next = podcastQueueRemoveEpisode(snapshot.items, episodeId)
            pushOrKeep(next)
            next
        }
        if (!advanceLocally) return
        if (!preferencesLoaded) {
            runCatching { repository.podcastQueuePreferences() }.onSuccess {
                mutex.withLock { applyPreferences(it) }
            }
        }
        if (remaining.isNotEmpty()) {
            val tracks = resolveTracks(remaining, null)
            if (tracks.isNotEmpty()) {
                prepareAdvance()
                play(tracks, 0, null, true)
            }
            return
        }
        if (episode == null || detail == null) {
            mutable.update { it.copy(queueError = podcastListFailure(context.getString(R.string.podcast_preferences_failed))) }
            return
        }
        val plan = podcastEndPlan(false, episode, detail, positions(), preferenceFor(episode.podcastId))
        when (plan.action) {
            PodcastEndAction.ADVANCE_QUEUE -> Unit
            PodcastEndAction.CONTINUE -> {
                val next = plan.episode ?: return
                // Derived playback only. podcastQueueAutoContinue must not be uploaded.
                check(podcastQueueAutoContinue(next.id) == listOf(next.id))
                val track = repository.rememberPodcastEpisode(next, detail.podcast)
                requireOwner(owner)
                prepareAdvance()
                play(listOf(track), 0, null, true)
            }
            PodcastEndAction.STOP -> Unit
        }
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

    private data class Placed(val items: List<PodcastQueueItem>, val remoteRead: Boolean, val atLimit: Boolean, val failure: Throwable?)

    private suspend fun placeOnCurrent(episodeId: String, index: Int): Placed {
        if (diverged) {
            val placement = podcastQueuePlace(snapshot.items, episodeId, index)
            snapshot = snapshot.copy(items = placement.items)
            mutable.update { it.copy(queue = placement.items) }
            return Placed(placement.items, remoteRead = true, atLimit = placement.atLimit, failure = null)
        }
        return try {
            val remote = repository.podcastQueue()
            snapshot = remote
            loaded = true
            val placement = podcastQueuePlace(remote.items, episodeId, index)
            snapshot = snapshot.copy(items = placement.items)
            mutable.update { it.copy(queue = placement.items, queueError = null) }
            Placed(placement.items, remoteRead = true, atLimit = placement.atLimit, failure = null)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            val placement = podcastQueuePlace(snapshot.items, episodeId, index)
            snapshot = snapshot.copy(items = placement.items)
            mutable.update { it.copy(queue = placement.items) }
            Placed(placement.items, remoteRead = false, atLimit = placement.atLimit, failure = error)
        }
    }

    private suspend fun placeEnqueue(episodeId: String, next: Boolean, after: String?): Placed {
        if (diverged) {
            val placement = podcastQueueEnqueue(snapshot.items, episodeId, next, after)
            snapshot = snapshot.copy(items = placement.items)
            mutable.update { it.copy(queue = placement.items) }
            return Placed(placement.items, remoteRead = true, atLimit = placement.atLimit, failure = null)
        }
        return try {
            val remote = repository.podcastQueue()
            snapshot = remote
            loaded = true
            val placement = podcastQueueEnqueue(remote.items, episodeId, next, after)
            snapshot = snapshot.copy(items = placement.items)
            mutable.update { it.copy(queue = placement.items) }
            Placed(placement.items, remoteRead = true, atLimit = placement.atLimit, failure = null)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            Placed(snapshot.items, remoteRead = false, atLimit = false, failure = error)
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
            mutable.update { it.copy(queue = snapshot.items, syncError = null, conflict = null, queueError = null) }
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

    private suspend fun dropInboxAfterQueue(episodeId: String) {
        try {
            repository.removePodcastInbox(episodeId)
            inbox = podcastInboxWithout(inbox, episodeId)
            publishInbox(inbox)
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) {
            mutable.update { it.copy(inboxError = context.getString(R.string.podcast_inbox_remove_failed)) }
            retry = { dropInboxAfterQueue(episodeId) }
        }
    }

    private suspend fun refreshInbox() {
        val fresh = repository.podcastInbox()
        inbox = fresh.items
        publishInbox(fresh.items)
    }

    private fun applyPreferences(saved: PodcastQueuePreferences) {
        preferences = saved.forUpload()
        preferencesLoaded = true
        settings.podcastContinuePreference(settings.podcastContinuePreference().copy(autoContinue = preferences.autoContinue))
        mutable.update { it.copy(preferences = preferences, preferencesLoading = false, preferencesError = null) }
    }

    private suspend fun publishInbox(items: List<PodcastInboxItem>) {
        val rows = describe(items.map { Triple(it.episodeId, it.podcastId, it.addedAt) })
        mutable.update { it.copy(inbox = items, inboxRows = rows, inboxLoading = false) }
    }

    private suspend fun publishQueueRows(items: List<PodcastQueueItem>) {
        val rows = describe(items.map { Triple(it.episodeId, "", it.addedAt) })
        val preview = computeAutoPreview(items)
        mutable.update { it.copy(queueRows = rows, queueLoading = false, autoPreview = preview) }
    }

    fun refreshAutoPreview() = scope.launch {
        val preview = computeAutoPreview(snapshot.items)
        mutable.update { it.copy(autoPreview = preview) }
    }

    private suspend fun computeAutoPreview(queue: List<PodcastQueueItem>): List<PodcastAutoPreviewItem> {
        val currentEpId = playingEpisodeId() ?: return emptyList()
        val anchorId = queue.lastOrNull()?.episodeId ?: currentEpId
        val anchorEpisode = repository.cachedPodcastEpisode(anchorId) ?: runCatching { repository.podcastEpisode(anchorId) }.getOrNull() ?: return emptyList()
        val detail = repository.cachedPodcastDetail(anchorEpisode.podcastId) ?: runCatching { repository.podcastDetail(anchorEpisode.podcastId) }.getOrNull() ?: return emptyList()
        val pref = preferenceFor(anchorEpisode.podcastId)
        if (!pref.enabled) return emptyList()

        val previewList = mutableListOf<PodcastAutoPreviewItem>()
        var currentAnchor = anchorEpisode
        val queuedIds = (queue.map { it.episodeId } + listOfNotNull(currentEpId)).toSet()
        for (step in 0 until 3) {
            val next = nextEpisode(currentAnchor, detail, positions(), pref) ?: break
            if (!queuedIds.contains(next.id) && previewList.none { it.episodeId == next.id }) {
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
                        if (episode == null) return@async PodcastQueueRow(episodeId, podcastId, "", "", addedAt, unavailable = true)
                        val show = repository.cachedPodcastDetail(episode.podcastId)?.podcast?.title
                            ?: runCatching { repository.podcastDetail(episode.podcastId).podcast.title }.getOrNull().orEmpty()
                        PodcastQueueRow(episode.id, episode.podcastId, episode.title, show, addedAt)
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

    private suspend fun alignPlayer(items: List<PodcastQueueItem>) {
        val current = playingEpisodeId() ?: return
        val tracks = resolveTracks(items, null)
        val index = tracks.indexOfFirst { podcastEpisodeId(it.id) == current }
        val c = player() ?: return
        if (index < 0) {
            if (tracks.isEmpty()) return
            prepareAdvance()
            play(tracks, 0, null, c.playWhenReady)
        } else {
            prepareAdvance()
            play(tracks, index, c.currentPosition.coerceAtLeast(0), c.playWhenReady)
        }
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
        val SHOW_ACTIONS = setOf("inbox", "queue_last", "queue_next", "ignore")
    }
}
