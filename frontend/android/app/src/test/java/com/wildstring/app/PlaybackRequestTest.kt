package com.wildstring.app

import com.google.gson.Gson
import com.wildstring.app.data.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class PlaybackRequestTest {
    private val original = "https://music.example/music/api/v1/tracks/real-id/stream"
    @Test fun originalAndAacRequestsKeepDistinctOffsetsAndCacheIdentities() {
        assertEquals(original, PlaybackRequest.url(original, 0, 6000))
        val aac = PlaybackRequest.url(original, 192, 6000)
        assertEquals(6000, PlaybackRequest.offset(aac))
        assertTrue(PlaybackRequest.isAac(aac))
        assertEquals("192", aac.toHttpUrl().queryParameter("bitrate_kbps"))
        assertNotEquals(aac, PlaybackRequest.url(original, 320, 6000))
        assertNotEquals(aac, PlaybackRequest.url(original, 192, 0))
        assertEquals(original, PlaybackRequest.url(aac, 0))
        assertThrows(IllegalArgumentException::class.java) { PlaybackRequest.url(original, 64) }
        assertThrows(IllegalArgumentException::class.java) { PlaybackRequest.url(original, 192, -1) }
    }
    @Test fun serverUrlsRespectConfiguredPrefixAndRejectForeignAudio() {
        val base = "https://music.example/music/".toHttpUrl()
        assertEquals(original, PlaybackRequest.stream(base, original.toHttpUrl(), "/api/v1/tracks/real-id/stream").toString())
        listOf("https://other.example/music/api/v1/tracks/real-id/stream", "/api/v1/tracks/other/stream", "../api/v1/tracks/real-id/stream", "/api/v1/tracks/real-id/stream?token=opaque").forEach {
            assertThrows(IllegalArgumentException::class.java) { PlaybackRequest.stream(base, original.toHttpUrl(), it) }
        }
    }
    @Test fun userIdentityAndEditedLyricsParseWithoutAssumingNumericIds() {
        val status = Gson().fromJson("""{"configured":true,"authenticated":true,"user":{"id":"user-uuid","username":"alice","role":"user","enabled":true,"version":2}}""", AuthStatus::class.java)
        assertEquals("user-uuid", status.user!!.id)
        assertEquals("user", status.user.role)
        val lyrics = Gson().fromJson("""{"kind":"synced","source":"user","lines":[{"time_ms":6000,"text":"人工歌词"}]}""", Lyrics::class.java)
        assertEquals("user", lyrics.source)
        assertEquals(6000L, lyrics.lines.single().timeMs)
        assertNull(Gson().fromJson("""{"configured":true,"authenticated":true}""", AuthStatus::class.java).user)
    }
}
