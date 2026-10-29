package com.wildstring.app

import com.wildstring.app.data.*
import java.io.IOException
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class PodcastBrowserTest {
    private val podcast = PodcastSummary("show", "节目", feedUrl = "https://example.com/rss")
    private fun detail(title: String = "单集") = PodcastDetail(podcast,
        listOf(PodcastEpisode("episode", "show", "guid", title, audioUrl = "https://example.com/audio.mp3")))

    private class Fixture : AutoCloseable {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var owner: String? = "server-A:user-A"
        var lists = 0
        var reads = 0
        var refreshes = 0
        var refreshAlls = 0
        var list: suspend () -> List<PodcastSummary> = { emptyList() }
        var read: suspend (String) -> PodcastDetail = { error("missing fixture") }
        var refresh: suspend (String) -> PodcastDetail = { read(it) }
        val browser = PodcastBrowser(scope, { owner }, { lists++; list() }, { null },
            { reads++; read(it) }, { refreshes++; refresh(it) }, { refreshAlls++; true })
        override fun close() { scope.cancel() }
    }

    @Test fun returningFromPlayerUsesExistingListAndEpisodesWithoutNetworkOrSourceRefresh() {
        Fixture().use { f ->
            f.list = { listOf(podcast) }; f.read = { detail() }
            repeat(4) { f.browser.ensureList(); f.browser.ensureDetail("show") }
            assertEquals(1, f.lists)
            assertEquals(1, f.reads)
            assertEquals(0, f.refreshes)
            assertEquals(0, f.refreshAlls)
            assertEquals("单集", f.browser.state.value.details["show"]!!.episodes.single().title)
            assertFalse(f.browser.state.value.listLoading)
            assertTrue(f.browser.state.value.loadingDetails.isEmpty())
        }
    }

    @Test fun returningWhileInitialRequestIsPendingDoesNotStartAnotherRequest() = runBlocking {
        Fixture().use { f ->
            val gate = CompletableDeferred<Unit>()
            f.read = { gate.await(); detail() }
            f.browser.ensureDetail("show")
            f.browser.ensureDetail("show")
            assertEquals(1, f.reads)
            assertTrue("show" in f.browser.state.value.loadingDetails)
            gate.complete(Unit)
            assertEquals(detail(), f.browser.state.value.details["show"])
            assertTrue(f.browser.state.value.loadingDetails.isEmpty())
        }
    }

    @Test fun explicitPullRefreshKeepsExistingContentAndRejectsDuplicatePulls() = runBlocking {
        Fixture().use { f ->
            f.read = { detail("旧单集") }
            f.browser.ensureDetail("show")
            val gate = CompletableDeferred<Unit>()
            f.refresh = { gate.await(); detail("新单集") }
            f.browser.refresh("show")
            f.browser.refresh("show")
            assertEquals(1, f.refreshes)
            assertEquals("旧单集", f.browser.state.value.details["show"]!!.episodes.single().title)
            assertTrue("show" in f.browser.state.value.loadingDetails)
            gate.complete(Unit)
            assertEquals("新单集", f.browser.state.value.details["show"]!!.episodes.single().title)
            assertTrue(f.browser.state.value.loadingDetails.isEmpty())
        }
    }

    @Test fun refreshFailureKeepsListAndOnlyAnExplicitRetryStartsAnotherRequest() {
        Fixture().use { f ->
            f.read = { detail() }; f.browser.ensureDetail("show")
            f.refresh = { throw IOException("offline") }
            f.browser.refresh("show")
            assertNotNull(f.browser.state.value.message)
            assertEquals(detail(), f.browser.state.value.details["show"])
            assertTrue(f.browser.state.value.loadingDetails.isEmpty())
            f.browser.ensureDetail("show")
            assertEquals(1, f.reads)
            assertEquals(1, f.refreshes)
            f.refresh = { detail("重试成功") }; f.browser.refresh("show")
            assertEquals("重试成功", f.browser.state.value.details["show"]!!.episodes.single().title)
        }
    }

    @Test fun changingServerOrAccountDiscardsEvenAnUncancellableLateResponse() = runBlocking {
        Fixture().use { f ->
            val gate = CompletableDeferred<Unit>()
            f.read = { withContext(NonCancellable) { gate.await() }; detail("账号 A") }
            f.browser.ensureDetail("show")
            f.owner = "server-B:user-B"
            f.read = { detail("账号 B") }
            f.browser.ensureDetail("show")
            gate.complete(Unit)
            assertEquals("server-B:user-B", f.browser.state.value.owner)
            assertEquals("账号 B", f.browser.state.value.details["show"]!!.episodes.single().title)
            assertTrue(f.browser.state.value.loadingDetails.isEmpty())
        }
    }

    @Test fun publisherCorrectionCannotBeOverwrittenByAnEarlierDetailRead() = runBlocking {
        Fixture().use { f ->
            val gate = CompletableDeferred<Unit>()
            f.read = { withContext(NonCancellable) { gate.await() }; detail() }
            f.browser.ensureDetail("show")
            val corrected = detail().copy(podcast = podcast.copy(publisher = PodcastPublisher("publisher", "已确认出品方")))
            f.browser.remember(corrected)
            gate.complete(Unit)
            assertEquals(corrected, f.browser.state.value.details["show"])
            assertEquals(corrected.podcast, f.browser.state.value.podcasts.single())
            f.browser.ensureDetail("show")
            assertEquals(1, f.reads)
        }
    }

    @Test fun listenerPullRefreshReadsSharedDataWithoutRequestingSourceUpdates() {
        Fixture().use { f ->
            f.list = { listOf(podcast) }; f.read = { detail() }
            f.browser.ensureList(); f.browser.ensureDetail("show")
            f.browser.reloadList(); f.browser.refresh("show", synchronize = false)
            assertEquals(2, f.lists)
            assertEquals(2, f.reads)
            assertEquals(0, f.refreshAlls)
            assertEquals(0, f.refreshes)
        }
    }

    @Test fun refreshingTheProgrammeListAlsoAllowsOneFreshReadWhenOpeningItsEpisodes() {
        Fixture().use { f ->
            f.list = { listOf(podcast) }; f.read = { detail("旧单集") }
            f.browser.ensureList(); f.browser.ensureDetail("show")
            f.browser.reloadList(synchronize = true)
            f.read = { detail("新增单集") }
            f.browser.ensureDetail("show"); f.browser.ensureDetail("show")
            assertEquals(1, f.refreshAlls)
            assertEquals(2, f.reads)
            assertEquals("新增单集", f.browser.state.value.details["show"]!!.episodes.single().title)
        }
    }
    @Test fun personalFollowChangesUpdateRetainedListAndDetailWithoutRefetching() {
        Fixture().use { f ->
            f.list = { listOf(podcast) }; f.read = { detail() }
            f.browser.ensureList(); f.browser.ensureDetail("show")
            f.browser.followed("show", true)
            assertTrue(f.browser.state.value.podcasts.single().followed)
            assertTrue(f.browser.state.value.details["show"]!!.podcast.followed)
            f.browser.followed("show", false)
            assertFalse(f.browser.state.value.podcasts.single().followed)
            assertFalse(f.browser.state.value.details["show"]!!.podcast.followed)
            assertEquals(1, f.lists); assertEquals(1, f.reads)
        }
    }

}
