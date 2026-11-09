package com.wildstring.app.data

import com.wildstring.app.AppLanguage
import com.wildstring.app.R

/**
 * Pure podcast queue and auto-continue policy for contracts/podcast-queue.md.
 * Cloud reads and writes live in Repository; these functions never touch the network.
 * §2.3 auto-continue writes no queue entry; §2.5 on-demand playback keeps existing
 * entries and their origin; §5 a non-empty queue wins over auto-continue.
 */

/** Shown when a queue write fails. Playback on this device still starts. */
val PODCAST_SYNC_FAILED: String get() = AppLanguage.string(R.string.pod_qpol_sync_failed)

const val PODCAST_QUEUE_LIMIT = 5000

/** Auto-continue sort direction (§5). OFF is the user-facing "关闭自动续播". */
enum class PodcastContinueOrder(val stored: String) {
    FOLLOW("follow"), OLDEST_FIRST("oldest"), NEWEST_FIRST("newest"), OFF("off");

    companion object {
        fun fromStored(value: String?): PodcastContinueOrder =
            entries.firstOrNull { it.stored == value } ?: FOLLOW
    }
}

/** Local stand-in for the server-synced preferences (§4, §6). */
data class PodcastContinuePreference(
    val order: PodcastContinueOrder = PodcastContinueOrder.FOLLOW,
    val skipCompleted: Boolean = true,
    val autoContinue: Boolean = true,
) {
    val enabled: Boolean get() = autoContinue && order != PodcastContinueOrder.OFF
}

private fun PodcastEpisode.isCompleted(progress: Map<String, EpisodeProgress>): Boolean =
    completed || progress[id]?.completed == true

/**
 * Contract §5: pure `nextEpisode(current, detail, progress, preference)`.
 * Stays within the current show, follows the configured order, skips completed episodes
 * by default and returns null when auto-continue is disabled or nothing is left.
 */
fun nextEpisode(
    current: PodcastEpisode,
    detail: PodcastDetail,
    progress: Map<String, EpisodeProgress> = emptyMap(),
    preference: PodcastContinuePreference = PodcastContinuePreference(),
): PodcastEpisode? {
    if (!preference.enabled) return null
    // §5: the current show is the boundary; never merge episodes from another show.
    if (detail.podcast.id != current.podcastId) return null
    val episodes = detail.episodes.filter { it.podcastId == current.podcastId }
    val ordered = when (preference.order) {
        PodcastContinueOrder.FOLLOW -> episodes
        PodcastContinueOrder.OLDEST_FIRST -> episodes.sortedBy { podcastPublishedMillis(it.pubDate) }
        PodcastContinueOrder.NEWEST_FIRST -> episodes.sortedByDescending { podcastPublishedMillis(it.pubDate) }
        PodcastContinueOrder.OFF -> return null
    }
    val index = ordered.indexOfFirst { it.id == current.id }
    if (index < 0) return null
    return ordered.drop(index + 1).firstOrNull { episode ->
        !preference.skipCompleted || !episode.isCompleted(progress)
    }
}

/**
 * Contract §2.5: an on-demand episode is inserted at the queue head and every existing
 * (manually queued) entry is preserved. An episode already in the queue moves to the head
 * instead of being stacked twice. Media ids model the local Media3 playlist.
 */
fun podcastQueueOnDemand(queue: List<String>, episode: String): List<String> =
    listOf(episode) + queue.filter { it != episode }

/**
 * Contract §2.3 / §5: auto-continue writes no queue entry. Played items leave the queue
 * and only the derived current episode remains — never `queue + episode`.
 */
fun podcastQueueAutoContinue(episode: String): List<String> = listOf(episode)

/** Contract §5: what the player should do when a podcast episode reaches its end. */
enum class PodcastEndAction { ADVANCE_QUEUE, CONTINUE, STOP }
data class PodcastEndPlan(val action: PodcastEndAction, val episode: PodcastEpisode? = null)

/**
 * Contract §5: a non-empty manual queue always wins. Auto-continue takes over only when
 * the queue is empty (here: no queued item after the current one).
 */
fun podcastEndPlan(
    hasQueuedNext: Boolean,
    current: PodcastEpisode,
    detail: PodcastDetail,
    progress: Map<String, EpisodeProgress> = emptyMap(),
    preference: PodcastContinuePreference = PodcastContinuePreference(),
): PodcastEndPlan {
    if (hasQueuedNext) return PodcastEndPlan(PodcastEndAction.ADVANCE_QUEUE)
    val next = nextEpisode(current, detail, progress, preference) ?: return PodcastEndPlan(PodcastEndAction.STOP)
    return PodcastEndPlan(PodcastEndAction.CONTINUE, next)
}

/** Contract §5: adjacent episodes of the same show, following the list order (FOLLOW). */
fun podcastAdjacentEpisodes(current: PodcastEpisode, detail: PodcastDetail): Pair<PodcastEpisode?, PodcastEpisode?> {
    if (detail.podcast.id != current.podcastId) return null to null
    val episodes = detail.episodes.filter { it.podcastId == current.podcastId }
    val index = episodes.indexOfFirst { it.id == current.id }
    if (index < 0) return null to null
    return episodes.getOrNull(index - 1) to episodes.getOrNull(index + 1)
}

/** Contract §5: podcasts never inherit music shuffle/repeat; any of them blocks auto-advance. */
fun podcastAdvanceBlocked(repeatOne: Boolean, repeatAll: Boolean, shuffle: Boolean): Boolean =
    repeatOne || repeatAll || shuffle

data class PodcastQueuePlacement(val items: List<PodcastQueueItem>, val added: Int, val atLimit: Boolean)

/** §2.5 with origin: new rows are manual; a row already queued keeps its origin and is not stacked. */
fun podcastQueuePlace(items: List<PodcastQueueItem>, episodeId: String, index: Int): PodcastQueuePlacement {
    val existing = items.firstOrNull { it.episodeId == episodeId }
    val rest = items.filter { it.episodeId != episodeId }
    if (existing == null && rest.size >= PODCAST_QUEUE_LIMIT) return PodcastQueuePlacement(items, added = 0, atLimit = true)
    val entry = existing ?: PodcastQueueItem(episodeId, origin = "manual")
    val at = index.coerceIn(0, rest.size)
    return PodcastQueuePlacement(rest.toMutableList().apply { add(at, entry) }, added = if (existing == null) 1 else 0, atLimit = false)
}

/** Append, or insert after the playing episode when [next] is set. Already-queued tail adds are a no-op. */
fun podcastQueueEnqueue(
    items: List<PodcastQueueItem>,
    episodeId: String,
    next: Boolean,
    afterEpisodeId: String? = null,
): PodcastQueuePlacement {
    if (!next && items.any { it.episodeId == episodeId }) return PodcastQueuePlacement(items, added = 0, atLimit = false)
    val rest = items.filter { it.episodeId != episodeId }
    val after = afterEpisodeId?.let { id -> rest.indexOfFirst { it.episodeId == id } } ?: -1
    val index = when {
        !next -> rest.size
        after >= 0 -> after + 1
        else -> 0
    }
    return podcastQueuePlace(items, episodeId, index)
}

fun podcastQueueRemoveEpisode(items: List<PodcastQueueItem>, episodeId: String): List<PodcastQueueItem> =
    items.filter { it.episodeId != episodeId }

fun podcastInboxWithout(items: List<PodcastInboxItem>, episodeId: String): List<PodcastInboxItem> =
    items.filter { it.episodeId != episodeId }

fun podcastQueueNormalize(items: List<PodcastQueueItem>): List<PodcastQueueItem> =
    items.map { item -> item.copy(origin = if (item.origin == "rule") "rule" else "manual") }

enum class PodcastQueueConflictChoice { KEEP_LOCAL, USE_SERVER, OVERWRITE }

data class PodcastQueueConflictResolution(val items: List<PodcastQueueItem>, val version: Int, val upload: Boolean)

/** Conflict keeps the device queue until the user picks the server copy or overwrites with that version. */
fun resolvePodcastQueueConflict(
    localItems: List<PodcastQueueItem>,
    serverVersion: Int,
    serverItems: List<PodcastQueueItem>,
    choice: PodcastQueueConflictChoice,
): PodcastQueueConflictResolution = when (choice) {
    PodcastQueueConflictChoice.KEEP_LOCAL -> PodcastQueueConflictResolution(localItems, serverVersion, upload = false)
    PodcastQueueConflictChoice.USE_SERVER -> PodcastQueueConflictResolution(serverItems, serverVersion, upload = false)
    PodcastQueueConflictChoice.OVERWRITE -> PodcastQueueConflictResolution(localItems, serverVersion, upload = true)
}

fun podcastPreferencesUpdatingShow(
    current: PodcastQueuePreferences,
    podcastId: String,
    show: PodcastShowQueuePreference,
): PodcastQueuePreferences = current.copy(shows = current.shows.orEmpty() + (podcastId to show))

/**
 * Account default `auto_continue`. Show rows that still match the previous default follow it;
 * a row that already differs is left as the per-show override.
 */
fun podcastPreferencesUpdatingAutoContinue(current: PodcastQueuePreferences, enabled: Boolean): PodcastQueuePreferences {
    val previous = current.autoContinue
    val shows = current.shows.orEmpty().mapValues { (_, show) ->
        if (show.autoContinue == previous) show.copy(autoContinue = enabled) else show
    }
    return current.copy(autoContinue = enabled, shows = shows)
}

fun normalizeDeliveryAction(action: String?): String = when (action) {
    "ignore" -> "ignore"
    "queue_next" -> "queue_next"
    "queue_last", "inbox" -> "queue_last"
    else -> "queue_last"
}

fun effectiveShowPreference(current: PodcastQueuePreferences, podcastId: String): PodcastShowQueuePreference {
    val show = current.shows.orEmpty()[podcastId]
    if (show != null) {
        return show.copy(action = normalizeDeliveryAction(show.action))
    }
    return PodcastShowQueuePreference(
        action = normalizeDeliveryAction(current.defaultAction),
        autoLimit = current.autoLimit,
        autoContinue = current.autoContinue,
    )
}

fun podcastContinueOrderFromApi(value: String?): PodcastContinueOrder = when (value) {
    "asc", "oldest" -> PodcastContinueOrder.OLDEST_FIRST
    "desc", "newest" -> PodcastContinueOrder.NEWEST_FIRST
    "off" -> PodcastContinueOrder.OFF
    else -> PodcastContinueOrder.FOLLOW
}

fun PodcastContinueOrder.toQueueApi(): String = when (this) {
    PodcastContinueOrder.FOLLOW -> "follow"
    PodcastContinueOrder.OLDEST_FIRST -> "asc"
    PodcastContinueOrder.NEWEST_FIRST -> "desc"
    PodcastContinueOrder.OFF -> "off"
}

/** Show row wins when present; otherwise the account default, then the on-device cache. */
fun podcastContinuePreferenceFor(
    preferences: PodcastQueuePreferences?,
    podcastId: String?,
    cached: PodcastContinuePreference,
): PodcastContinuePreference {
    val show = podcastId?.let { preferences?.shows.orEmpty()[it] }
    if (show != null) {
        return PodcastContinuePreference(
            order = podcastContinueOrderFromApi(show.order),
            skipCompleted = show.skipCompleted,
            autoContinue = show.autoContinue,
        )
    }
    return cached.copy(autoContinue = preferences?.autoContinue ?: cached.autoContinue)
}

fun podcastSyncFailureMessage(reason: String, headline: String = PODCAST_SYNC_FAILED): String {
    val detail = reason.trim()
    return if (detail.isEmpty()) AppLanguage.string(R.string.pod_qpol_sync_retry_empty, headline)
    else AppLanguage.string(R.string.pod_qpol_sync_retry_detail, headline, detail)
}

fun podcastListFailure(reason: String): String {
    val text = reason.trim()
    return if (text.contains("\u91cd\u8bd5") || text.contains("\u8bf7") || text.contains("retry", ignoreCase = true) || text.contains("please", ignoreCase = true)) text
    else AppLanguage.string(R.string.pod_qpol_list_failure_suffix, text)
}

class PodcastQueueConflictException(val current: PodcastQueueSnapshot) : java.io.IOException("podcast_queue_conflict")

fun PodcastQueueSnapshot.normalized(): PodcastQueueSnapshot = copy(items = podcastQueueNormalize(items))

fun PodcastQueuePreferences.forUpload(): PodcastQueuePreferences = copy(
    defaultAction = defaultAction.ifBlank { "inbox" },
    autoLimit = autoLimit.coerceIn(0, 100),
    shows = shows.orEmpty(),
)
