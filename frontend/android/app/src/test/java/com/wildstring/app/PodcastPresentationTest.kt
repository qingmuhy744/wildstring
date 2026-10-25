package com.wildstring.app

import com.google.gson.Gson
import com.wildstring.app.data.*
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class PodcastPresentationTest {
    private fun episode(position: Int = 85, completed: Boolean = false) = PodcastEpisode(
        id = "episode-1", podcastId = "show-1", guid = "episode-1", title = "本期节目",
        audioUrl = "https://audio.example.com/episode.mp3", durationSeconds = 7200,
        positionSeconds = position, completed = completed,
    )

    @Test fun restoredTrackKeepsItsPodcastIdentityAndArtwork() {
        val show = PodcastSummary("show-1", "声东击西", author = "ETW Studio", feedUrl = "https://example.com/rss", coverUrl = "https://example.com/cover.jpg")
        val gson = Gson()
        val restored = gson.fromJson(gson.toJson(episode().toTrack(show)), Track::class.java)
        assertTrue(restored.isPodcast)
        assertEquals("episode-1", restored.podcastEpisodeId)
        assertEquals("show-1", restored.podcast?.podcastId)
        assertEquals("https://example.com/cover.jpg", restored.podcast?.coverUrl)
        assertTrue(restored.hasCover)
        // Queues saved by an older app can still identify the episode and rehydrate it.
        assertEquals("episode-1", gson.fromJson("""{"id":"podcast_ep_episode-1","title":"old"}""", Track::class.java).podcastEpisodeId)
        assertNull(podcastEpisodeId("music-id"))
    }

    @Test fun timeLinksSupportLongEpisodesAndRejectInvalidOrOutOfRangeTimes() {
        val article = "开场 [03:52]；转折 01:03:36；结尾 107:02。错误 01:70:03、3:65；片尾 02:00:00"
        val times = podcastTimestamps(article, 7200_000)
        assertEquals(listOf(232_000L, 3816_000L, 6422_000L), times.map { it.positionMs })
        assertEquals(listOf("03:52", "01:03:36", "107:02"), times.map { article.substring(it.start, it.end) })
        assertEquals(0L, podcastTimestamps("00:00", 60_000).single().positionMs)
    }

    @Test fun resumeUsesSavedPositionAndCompletedEpisodesRestart() {
        assertEquals(85_000L, podcastResumePosition(episode()))
        assertEquals(0L, podcastResumePosition(episode(completed = true)))
        assertEquals(0L, podcastResumePosition(episode(position = -1)))
        assertEquals(7200_000L, podcastResumePosition(episode(position = 9999)))
    }

    @Test fun podcastPlaybackRemainsOriginalWhenMusicQualityChanges() {
        val url = "https://music.example.com/api/v1/podcasts/episodes/episode-1/stream?proxy=1&cache=1&network=wifi"
        assertEquals(url, PlaybackRequest.url(url, 320, 85_000))
        assertFalse(PlaybackRequest.isAac(PlaybackRequest.url(url, 192)))
        assertTrue(PlaybackRequest.isAac(PlaybackRequest.url("https://music.example.com/api/v1/tracks/music-1/stream", 192)))
    }

    @Test fun publicArtworkNeverRetainsCookiesOrAddsServerCredentials() {
        MockWebServer().use { origin -> MockWebServer().use { cdn ->
            origin.start(); cdn.start()
            origin.enqueue(MockResponse().setResponseCode(302).addHeader("Set-Cookie", "wildstring_session=private; Path=/").addHeader("Location", cdn.url("/cover.jpg")))
            cdn.enqueue(MockResponse().setBody("image"))
            val client = podcastArtworkClient()
            client.newCall(Request.Builder().url(origin.url("/cover")).build()).execute().use { assertTrue(it.isSuccessful) }
            listOf(origin.takeRequest(), cdn.takeRequest()).forEach { request ->
                assertNull(request.getHeader("Cookie"))
                assertNull(request.getHeader("Authorization"))
                assertNull(request.getHeader("X-Wildstring-Client"))
            }
            assertTrue(client.cookieJar.loadForRequest(origin.url("/")).isEmpty())
        } }
        listOf("javascript:alert(1)", "file:///data/private", "https://user:password@example.com/image").forEach { assertNull(podcastArtworkUrl(it)) }
    }

    @Test fun publicationSortUsesTheDateInsteadOfTheWeekdayString() {
        val old = podcastPublishedMillis("Wed, 31 Jan 2018 00:00:00 GMT")
        val new = podcastPublishedMillis("Thu, 22 Oct 2026 00:00:00 GMT")
        assertTrue(new > old)
        assertEquals(new, podcastPublishedMillis("2026-10-22T00:00:00Z"))
        assertEquals(0L, podcastPublishedMillis("not a date"))
    }
}
