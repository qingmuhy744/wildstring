package com.wildstring.app.ui

/** Ascending join time; blank legacy timestamps stay ahead of every dated row. */
internal fun orderPendingRows(rows: List<PodcastQueueRow>): List<PodcastQueueRow> =
    rows.sortedBy { it.addedAt }
