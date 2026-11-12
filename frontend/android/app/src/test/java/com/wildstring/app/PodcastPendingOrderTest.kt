package com.wildstring.app

import com.wildstring.app.ui.PodcastQueueRow
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
}
