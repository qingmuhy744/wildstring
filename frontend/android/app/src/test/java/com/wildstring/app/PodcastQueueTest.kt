package com.wildstring.app

import com.wildstring.app.data.*
import org.junit.Assert.*
import org.junit.Test

/** Local queue / auto-continue behavior from contracts/podcast-queue.md §2 and §5. */
class PodcastQueueTest {
    private fun episode(id: String, podcastId: String = "show", pubDate: String = "", completed: Boolean = false) =
        PodcastEpisode(id = id, podcastId = podcastId, guid = id, title = "Episode $id",
            audioUrl = "https://example.test/$id.mp3", pubDate = pubDate, completed = completed)

    private fun detail(vararg episodes: PodcastEpisode) =
        PodcastDetail(PodcastSummary(id = "show", title = "Show", feedUrl = "https://example.test/feed.xml"), episodes.toList())

    @Test fun onDemandInsertsAtHeadAndPreservesEveryManualEntry() {
        val queue = listOf("manual-a", "manual-b", "manual-c")
        val result = podcastQueueOnDemand(queue, "on-demand")
        assertEquals(4, result.size)                  // queue length grows by one
        assertEquals("on-demand", result.first())     // inserted at the queue head
        assertEquals(queue, result.drop(1))           // manual entries not cleared, order kept
        assertTrue(result.containsAll(queue))
    }

    @Test fun onDemandAlreadyQueuedEpisodeMovesToHeadWithoutStacking() {
        val queue = listOf("first", "on-demand", "last")
        val result = podcastQueueOnDemand(queue, "on-demand")
        assertEquals(3, result.size)
        assertEquals("on-demand", result.first())
        assertEquals(listOf("first", "last"), result.drop(1))
    }

    @Test fun autoContinueWritesNoQueueEntry() {
        val result = podcastQueueAutoContinue("ep-3")
        assertEquals(1, result.size)                  // only the derived current episode
        assertEquals(listOf("ep-3"), result)          // never queue + episode
    }

    @Test fun nextEpisodeFollowsTheListAndSkipsCompletedByDefault() {
        val e1 = episode("1", pubDate = "2024-01-01T00:00:00Z")
        val e2 = episode("2", pubDate = "2024-02-01T00:00:00Z", completed = true)
        val e3 = episode("3", pubDate = "2024-03-01T00:00:00Z")
        assertEquals(e3, nextEpisode(e1, detail(e1, e2, e3)))
    }

    @Test fun completionReportedThroughProgressIsAlsoSkipped() {
        val e1 = episode("1"); val e2 = episode("2"); val e3 = episode("3")
        val progress = mapOf("2" to EpisodeProgress("2", completed = true))
        assertEquals(e3, nextEpisode(e1, detail(e1, e2, e3), progress))
        assertEquals(e2, nextEpisode(e1, detail(e1, e2, e3), preference = PodcastContinuePreference(skipCompleted = false)))
    }

    @Test fun autoContinueCanBeDisabledByPreference() {
        val e1 = episode("1"); val e2 = episode("2")
        assertNull(nextEpisode(e1, detail(e1, e2), preference = PodcastContinuePreference(autoContinue = false)))
        assertNull(nextEpisode(e1, detail(e1, e2), preference = PodcastContinuePreference(order = PodcastContinueOrder.OFF)))
        assertEquals(PodcastContinueOrder.FOLLOW, PodcastContinueOrder.fromStored(null))
        assertEquals(PodcastContinueOrder.NEWEST_FIRST, PodcastContinueOrder.fromStored("newest"))
    }

    @Test fun oldestAndNewestOrdersFollowPublishDates() {
        val e1 = episode("1", pubDate = "2024-01-01T00:00:00Z")
        val e2 = episode("2", pubDate = "2024-02-01T00:00:00Z")
        val e3 = episode("3", pubDate = "2024-03-01T00:00:00Z")
        val scrambled = detail(e3, e1, e2)
        assertEquals(e2, nextEpisode(e1, scrambled, preference = PodcastContinuePreference(order = PodcastContinueOrder.OLDEST_FIRST)))
        assertEquals(e2, nextEpisode(e3, scrambled, preference = PodcastContinuePreference(order = PodcastContinueOrder.NEWEST_FIRST)))
    }

    @Test fun nextEpisodeNeverCrossesShows() {
        val e1 = episode("1")
        val other = episode("2", podcastId = "other-show")
        assertNull(nextEpisode(e1, detail(e1, other)))
        assertNull(nextEpisode(e1, PodcastDetail(PodcastSummary(id = "other-show", title = "Other", feedUrl = "x"), listOf(e1, other))))
    }

    @Test fun aNonEmptyManualQueueAlwaysWinsOverAutoContinue() {
        val e1 = episode("1"); val e2 = episode("2")
        val plan = podcastEndPlan(true, e1, detail(e1, e2))
        assertEquals(PodcastEndAction.ADVANCE_QUEUE, plan.action)
        assertNull(plan.episode)
    }

    @Test fun anEmptyQueueContinuesToTheNextEpisodeOnEnd() {
        val e1 = episode("1"); val e2 = episode("2")
        val plan = podcastEndPlan(false, e1, detail(e1, e2))
        assertEquals(PodcastEndAction.CONTINUE, plan.action)
        assertEquals(e2, plan.episode)
    }

    @Test fun disablingAutoContinueStopsPlaybackButKeepsTheManualQueue() {
        val e1 = episode("1"); val e2 = episode("2")
        val off = PodcastContinuePreference(autoContinue = false)
        assertEquals(PodcastEndAction.STOP, podcastEndPlan(false, e1, detail(e1, e2), preference = off).action)
        assertEquals(PodcastEndAction.ADVANCE_QUEUE, podcastEndPlan(true, e1, detail(e1, e2), preference = off).action)
    }

    @Test fun adjacentEpisodesStayWithinTheSameShow() {
        val e1 = episode("1"); val e2 = episode("2"); val e3 = episode("3")
        val (previous, next) = podcastAdjacentEpisodes(e2, detail(e1, e2, e3))
        assertEquals(e1, previous)
        assertEquals(e3, next)
        assertNull(podcastAdjacentEpisodes(e1, detail(e1, e2, e3)).first)
        assertNull(podcastAdjacentEpisodes(e3, detail(e1, e2, e3)).second)
    }

    @Test fun onDemandKeepsExistingOriginAndMarksNewEntriesManual() {
        val items = listOf(PodcastQueueItem("a", "rule"), PodcastQueueItem("b", "manual"))
        val moved = podcastQueuePlace(items, "b", 0).items
        assertEquals(listOf("b", "a"), moved.map { it.episodeId })
        assertEquals("manual", moved.first().origin)
        val inserted = podcastQueuePlace(items, "c", 0)
        assertEquals(1, inserted.added)
        assertEquals(listOf("c", "a", "b"), inserted.items.map { it.episodeId })
        assertEquals("manual", inserted.items.first().origin)
        assertEquals("rule", inserted.items[1].origin)
    }

    @Test fun queueLimitDoesNotDropExistingEntries() {
        val items = List(PODCAST_QUEUE_LIMIT) { PodcastQueueItem("ep-$it", "manual") }
        val placed = podcastQueuePlace(items, "extra", 0)
        assertTrue(placed.atLimit)
        assertEquals(0, placed.added)
        assertEquals(PODCAST_QUEUE_LIMIT, placed.items.size)
        assertFalse(placed.items.any { it.episodeId == "extra" })
    }

    @Test fun playedEpisodeLeavesTheQueueAndAutoContinueIsNotAppended() {
        val left = podcastQueueRemoveEpisode(listOf(PodcastQueueItem("done", "manual"), PodcastQueueItem("next", "rule")), "done")
        assertEquals(listOf("next"), left.map { it.episodeId })
        assertEquals("rule", left.single().origin)
        assertEquals(listOf("derived"), podcastQueueAutoContinue("derived"))
        assertFalse(left.any { it.episodeId == "derived" })
    }

    @Test fun conflictKeepsLocalUntilTheUserChooses() {
        val local = listOf(PodcastQueueItem("local", "manual"))
        val server = listOf(PodcastQueueItem("server", "rule"))
        val kept = resolvePodcastQueueConflict(local, 4, server, PodcastQueueConflictChoice.KEEP_LOCAL)
        assertEquals(local, kept.items)
        assertFalse(kept.upload)
        val overwrite = resolvePodcastQueueConflict(local, 4, server, PodcastQueueConflictChoice.OVERWRITE)
        assertEquals(4, overwrite.version)
        assertEquals(local, overwrite.items)
        assertTrue(overwrite.upload)
        val take = resolvePodcastQueueConflict(local, 4, server, PodcastQueueConflictChoice.USE_SERVER)
        assertEquals(server, take.items)
        assertFalse(take.upload)
    }

    @Test fun updatingOneShowKeepsTheOthersAndDefaultAutoContinue() {
        val current = PodcastQueuePreferences(
            defaultAction = "inbox",
            autoLimit = 3,
            autoContinue = false,
            shows = mapOf(
                "a" to PodcastShowQueuePreference(action = "ignore", autoLimit = 1),
                "b" to PodcastShowQueuePreference(action = "queue_last", autoLimit = 2, autoContinue = false),
            ),
        )
        val next = podcastPreferencesUpdatingShow(current, "b", current.shows.orEmpty().getValue("b").copy(action = "queue_next", autoLimit = 4))
        assertEquals("ignore", next.shows.orEmpty().getValue("a").action)
        assertEquals("queue_next", next.shows.orEmpty().getValue("b").action)
        assertEquals(4, next.shows.orEmpty().getValue("b").autoLimit)
        assertFalse(next.autoContinue)
        assertEquals("inbox", next.defaultAction)
    }

    @Test fun defaultAutoContinueFollowsMatchingShowsOnly() {
        val current = PodcastQueuePreferences(
            autoContinue = true,
            shows = mapOf(
                "follow" to PodcastShowQueuePreference(autoContinue = true, action = "inbox"),
                "override" to PodcastShowQueuePreference(autoContinue = false, action = "ignore"),
            ),
        )
        val next = podcastPreferencesUpdatingAutoContinue(current, false)
        assertFalse(next.autoContinue)
        assertFalse(next.shows.orEmpty().getValue("follow").autoContinue)
        assertEquals("inbox", next.shows.orEmpty().getValue("follow").action)
        assertFalse(next.shows.orEmpty().getValue("override").autoContinue)
        assertEquals("ignore", next.shows.orEmpty().getValue("override").action)
    }

    @Test fun apiOrderUsesAscDesc() {
        assertEquals("asc", PodcastContinueOrder.OLDEST_FIRST.toQueueApi())
        assertEquals("desc", PodcastContinueOrder.NEWEST_FIRST.toQueueApi())
        assertEquals("follow", PodcastContinueOrder.FOLLOW.toQueueApi())
        assertEquals("off", PodcastContinueOrder.OFF.toQueueApi())
        assertEquals(PodcastContinueOrder.OLDEST_FIRST, podcastContinueOrderFromApi("asc"))
        assertEquals(PodcastContinueOrder.NEWEST_FIRST, podcastContinueOrderFromApi("desc"))
        assertEquals(PodcastContinueOrder.OFF, podcastContinueOrderFromApi("off"))
        assertEquals(PodcastContinueOrder.FOLLOW, podcastContinueOrderFromApi("follow"))
    }

    @Test fun showAutoContinueOverridesTheAccountDefault() {
        val prefs = PodcastQueuePreferences(
            autoContinue = true,
            shows = mapOf("show" to PodcastShowQueuePreference(autoContinue = false, order = "asc", skipCompleted = false)),
        )
        val cached = PodcastContinuePreference(autoContinue = true)
        val show = podcastContinuePreferenceFor(prefs, "show", cached)
        assertFalse(show.autoContinue)
        assertEquals(PodcastContinueOrder.OLDEST_FIRST, show.order)
        assertFalse(show.skipCompleted)
        assertTrue(podcastContinuePreferenceFor(prefs, "other", cached).autoContinue)
        assertFalse(podcastContinuePreferenceFor(null, "show", cached.copy(autoContinue = false)).autoContinue)
    }

    @Test fun movingToTheQueueDropsTheInboxCopy() {
        val inbox = listOf(PodcastInboxItem("ep", "show", "manual"), PodcastInboxItem("other", "show", "rule"))
        assertEquals(listOf("other"), podcastInboxWithout(inbox, "ep").map { it.episodeId })
    }

    @Test fun syncFailureKeepsTheRequiredSentenceAndARetry() {
        val message = podcastSyncFailureMessage("无法连接服务器，请检查地址和网络。")
        assertTrue(message.contains(PODCAST_SYNC_FAILED))
        assertTrue(message.contains("可以重试"))
        assertTrue(message.contains("无法连接"))
    }

    @Test fun playNextInsertsAfterTheCurrentEpisodeWithoutStacking() {
        val items = listOf(PodcastQueueItem("now", "manual"), PodcastQueueItem("later", "rule"))
        val placed = podcastQueueEnqueue(items, "fresh", next = true, afterEpisodeId = "now")
        assertEquals(listOf("now", "fresh", "later"), placed.items.map { it.episodeId })
        assertEquals("manual", placed.items[1].origin)
        assertEquals("rule", placed.items[2].origin)
        val again = podcastQueueEnqueue(placed.items, "later", next = false)
        assertEquals(0, again.added)
        assertEquals(placed.items.map { it.episodeId }, again.items.map { it.episodeId })
    }

    @Test fun musicRepeatOrShuffleModesWouldBlockPodcastAdvance() {
        assertTrue(podcastAdvanceBlocked(repeatOne = true, repeatAll = false, shuffle = false))
        assertTrue(podcastAdvanceBlocked(repeatOne = false, repeatAll = true, shuffle = false))
        assertTrue(podcastAdvanceBlocked(repeatOne = false, repeatAll = false, shuffle = true))
        assertFalse(podcastAdvanceBlocked(repeatOne = false, repeatAll = false, shuffle = false))
    }

    @Test fun crossShowQueueTransitionContinuesWithSecondShowPolicyWithoutWritingQueue() {
        val showA = PodcastSummary(id = "show-a", title = "Show A", feedUrl = "https://example.test/a.xml")
        val showB = PodcastSummary(id = "show-b", title = "Show B", feedUrl = "https://example.test/b.xml")
        val a1 = episode("a1", podcastId = "show-a", pubDate = "2024-01-01T00:00:00Z")
        val a2 = episode("a2", podcastId = "show-a", pubDate = "2024-01-02T00:00:00Z")
        val b1 = episode("b1", podcastId = "show-b", pubDate = "2024-02-01T00:00:00Z")
        val b2 = episode("b2", podcastId = "show-b", pubDate = "2024-02-02T00:00:00Z", completed = true)
        val b3 = episode("b3", podcastId = "show-b", pubDate = "2024-02-03T00:00:00Z")
        val detailA = PodcastDetail(showA, listOf(a2, a1))
        val detailB = PodcastDetail(showB, listOf(b3, b2, b1))

        val prefs = PodcastQueuePreferences(
            autoContinue = false,
            shows = mapOf(
                "show-a" to PodcastShowQueuePreference(order = "follow", skipCompleted = true, autoContinue = true),
                "show-b" to PodcastShowQueuePreference(order = "asc", skipCompleted = true, autoContinue = true),
            ),
        )
        val cached = PodcastContinuePreference(autoContinue = false)

        // Initial explicit queue has [a2, b1].
        var queue = listOf(PodcastQueueItem("a2", "manual"), PodcastQueueItem("b1", "manual"))

        // 1. a2 finishes -> remaining queue has [b1], so ADVANCE_QUEUE wins over Show A's continuation (a1).
        queue = podcastQueueRemoveEpisode(queue, "a2")
        val afterA2 = podcastEndPlan(
            hasQueuedNext = queue.isNotEmpty(),
            current = a2,
            detail = detailA,
            preference = podcastContinuePreferenceFor(prefs, "show-a", cached),
        )
        assertEquals(PodcastEndAction.ADVANCE_QUEUE, afterA2.action)
        assertEquals(listOf("b1"), queue.map { it.episodeId })

        // 2. b1 finishes -> queue becomes empty; continuation switches to Show B (asc, skipping completed b2 -> b3).
        queue = podcastQueueRemoveEpisode(queue, "b1")
        assertTrue(queue.isEmpty())
        val afterB1 = podcastEndPlan(
            hasQueuedNext = queue.isNotEmpty(),
            current = b1,
            detail = detailB,
            preference = podcastContinuePreferenceFor(prefs, "show-b", cached),
        )
        assertEquals(PodcastEndAction.CONTINUE, afterB1.action)
        assertEquals(b3, afterB1.episode)
        // Auto-continue never writes back to the cloud queue.
        assertTrue(queue.isEmpty())

        // 3. b3 finishes at the end of Show B -> stops cleanly without wrapping around or crossing shows.
        val afterB3 = podcastEndPlan(
            hasQueuedNext = false,
            current = b3,
            detail = detailB,
            preference = podcastContinuePreferenceFor(prefs, "show-b", cached),
        )
        assertEquals(PodcastEndAction.STOP, afterB3.action)
        assertNull(afterB3.episode)
    }

    @Test fun normalizeDeliveryActionNormalizesLegacyInboxToQueueLast() {
        assertEquals("queue_last", normalizeDeliveryAction("inbox"))
        assertEquals("queue_last", normalizeDeliveryAction(""))
        assertEquals("queue_last", normalizeDeliveryAction(null))
        assertEquals("queue_last", normalizeDeliveryAction("unknown"))
        assertEquals("queue_last", normalizeDeliveryAction("queue_last"))
        assertEquals("queue_next", normalizeDeliveryAction("queue_next"))
        assertEquals("ignore", normalizeDeliveryAction("ignore"))
    }

    @Test fun effectiveShowPreferenceNormalizesDeliveryAction() {
        val prefs = PodcastQueuePreferences(
            autoContinue = true,
            shows = mapOf(
                "legacy-show" to PodcastShowQueuePreference(action = "inbox", autoLimit = 5),
                "next-show" to PodcastShowQueuePreference(action = "queue_next"),
            ),
        )
        val legacy = effectiveShowPreference(prefs, "legacy-show")
        assertEquals("queue_last", legacy.action)

        val next = effectiveShowPreference(prefs, "next-show")
        assertEquals("queue_next", next.action)

        val defaultPref = effectiveShowPreference(prefs, "unconfigured-show")
        assertEquals("queue_last", defaultPref.action)
    }

    @Test fun podcastEpisodeFavoriteFlagsReflectLovedAndFavorite() {
        val defaultEp = episode("ep1")
        assertFalse(defaultEp.loved)
        assertFalse(defaultEp.favorite)
        assertFalse(defaultEp.isFavorite)

        val lovedEp = defaultEp.copy(loved = true)
        assertTrue(lovedEp.loved)
        assertTrue(lovedEp.isFavorite)

        val favEp = defaultEp.copy(favorite = true)
        assertTrue(favEp.favorite)
        assertTrue(favEp.isFavorite)

        val bothEp = defaultEp.copy(loved = true, favorite = true)
        assertTrue(bothEp.isFavorite)
    }

    @Test fun discoveryCacheTTLIsOneHour() {
        assertEquals(3600_000L, DISCOVERY_CACHE_TTL)
    }

    @Test fun normalizeDeliveryActionAdversarialInputs() {
        val invalidInputs = listOf(
            "INBOX", "QUEUE_LAST", "QUEUE_NEXT", "IGNORE",
            "inbox", " inbox ", "  ", "\t\n", "undefined", "null",
            "random_string", "12345", "queue_first", "later",
        )
        for (input in invalidInputs) {
            assertEquals("Expected $input to normalize to queue_last", "queue_last", normalizeDeliveryAction(input))
        }
        assertEquals("queue_last", normalizeDeliveryAction(null))
        assertEquals("queue_last", normalizeDeliveryAction(""))
        assertEquals("queue_last", normalizeDeliveryAction("queue_last"))
        assertEquals("queue_next", normalizeDeliveryAction("queue_next"))
        assertEquals("ignore", normalizeDeliveryAction("ignore"))
    }

    @Test fun episodeFavoriteTruthTableExhaustive() {
        val cases = listOf(
            Triple(false, false, false),
            Triple(true, false, true),
            Triple(false, true, true),
            Triple(true, true, true),
        )
        for ((loved, favorite, expected) in cases) {
            val ep = episode("test").copy(loved = loved, favorite = favorite)
            assertEquals("isFavorite mismatch for loved=$loved, favorite=$favorite", expected, ep.isFavorite)
        }
    }

    @Test fun discoveryCacheTTLBoundarySimulation() {
        val t0 = 1_000_000_000L
        val ttl = DISCOVERY_CACHE_TTL

        val isHit = { now: Long -> (now - t0) < ttl }

        // Immediately after fetch (t0) -> Hit
        assertTrue(isHit(t0))

        // 3599 seconds later (t0 + 3599_000ms) -> Hit
        assertTrue(isHit(t0 + 3599_000L))

        // Exactly 3600 seconds later (t0 + 3600_000ms) -> Miss (expired)
        assertFalse(isHit(t0 + 3600_000L))

        // 3601 seconds later (t0 + 3601_000ms) -> Miss
        assertFalse(isHit(t0 + 3601_000L))

        // 2 hours later -> Miss
        assertFalse(isHit(t0 + 7200_000L))
    }

    @Test fun downloadQueueAcceptsFractionalProgress() {
        val json = """{"total_pending":1,"downloading":[{"episode_id":"e1","progress_pct":42.5}],"recent_completed":[{"episode_id":"e2","progress_pct":96.5}]}"""
        val info = com.google.gson.Gson().fromJson(json, PodcastDownloadQueueInfo::class.java)
        assertEquals(42.5, info.downloading.single().progressPct!!, 0.0)
        assertEquals(96.5, info.recentCompleted.single().progressPct!!, 0.0)
    }
}
