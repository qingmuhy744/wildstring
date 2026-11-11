package com.wildstring.app

import com.wildstring.app.ui.PodcastQueueRow
import com.wildstring.app.ui.mergePendingRows
import com.wildstring.app.ui.orderPendingRows
import org.junit.Assert.assertEquals
import org.junit.Test

class PodcastPendingOrderTest {
    private fun row(id: String, addedAt: String) = PodcastQueueRow(id, "show", id, "Show", addedAt)

    @Test fun ordersByJoinTimeAndKeepsLegacyRowsFirst() {
        val ordered = orderPendingRows(
            listOf(
                row("late", "2026-11-09T10:00:00+00:00"),
                row("legacy-b", ""),
                row("early", "2026-11-08T09:00:00+00:00"),
                row("legacy-a", ""),
            ),
        )
        assertEquals(listOf("legacy-b", "legacy-a", "early", "late"), ordered.map { it.episodeId })
    }

    @Test fun equalTimestampsKeepTheirInputOrder() {
        val ordered = orderPendingRows(listOf(row("a", "2026-11-09T10:00:00+00:00"), row("b", "2026-11-09T10:00:00+00:00")))
        assertEquals(listOf("a", "b"), ordered.map { it.episodeId })
    }

    @Test fun mergeKeepsManualQueueOrderAndAppendsSortedUnqueuedInbox() {
        val merged = mergePendingRows(
            queueRows = listOf(
                row("dragged-newer", "2026-11-10T12:00:00+00:00"),
                row("older-queued", "2026-11-08T08:00:00+00:00"),
            ),
            inboxRows = listOf(
                row("inbox-late", "2026-11-10T09:00:00+00:00"),
                row("older-queued", "2026-11-08T08:00:00+00:00"),
                row("inbox-early", "2026-11-09T07:00:00+00:00"),
            ),
        )
        assertEquals(
            listOf(
                "dragged-newer" to true,
                "older-queued" to true,
                "inbox-early" to false,
                "inbox-late" to false,
            ),
            merged.map { it.first.episodeId to it.second },
        )
    }
}
