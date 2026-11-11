package com.wildstring.app.ui

/** Ascending join time; blank legacy timestamps stay ahead of every dated row. */
internal fun orderPendingRows(rows: List<PodcastQueueRow>): List<PodcastQueueRow> =
    rows.sortedBy { it.addedAt }

/**
 * Explicit queue rows keep their server/user queue order so head-inserts, play-next
 * and manual drag-reorder never snap back; unqueued inbox rows follow in join-time order.
 */
internal fun mergePendingRows(
    queueRows: List<PodcastQueueRow>,
    inboxRows: List<PodcastQueueRow>,
): List<Pair<PodcastQueueRow, Boolean>> {
    val seen = HashSet<String>(queueRows.size)
    val combined = ArrayList<Pair<PodcastQueueRow, Boolean>>(queueRows.size + inboxRows.size)
    for (row in queueRows) {
        if (seen.add(row.episodeId)) {
            combined.add(row to true)
        }
    }
    val unqueuedInbox = inboxRows.filter { seen.add(it.episodeId) }
    for (row in orderPendingRows(unqueuedInbox)) {
        combined.add(row to false)
    }
    return combined
}
