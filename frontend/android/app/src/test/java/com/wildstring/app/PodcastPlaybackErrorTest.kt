package com.wildstring.app

import com.wildstring.app.data.friendlyError
import com.wildstring.app.playback.podcastPlaybackMessage
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class PodcastPlaybackErrorTest {
    @Test fun upstreamFailureIsNotReportedAsAFormatProblem() {
        val upstream = podcastPlaybackMessage(502, """{"detail":"podcast_audio_upstream_failed"}""", false)
        assertTrue(upstream.contains("播客源站暂时无法连接"))
        assertEquals(upstream, podcastPlaybackMessage(502, "", false))
        assertEquals(upstream, podcastPlaybackMessage(null, "", true))
    }

    @Test fun fakeIpAndRangeErrorsHaveTheirOwnHints() {
        assertTrue(podcastPlaybackMessage(422, """{"detail":"remote_url_fake_ip"}""", false).contains("fake-ip"))
        assertTrue(podcastPlaybackMessage(416, "", false).contains("从头播放"))
        assertTrue(podcastPlaybackMessage(null, "", false).contains("音频格式"))
    }

    @Test fun subscribeRejectionExplainsFakeIpDns() {
        val body = """{"detail":"remote_url_fake_ip"}""".toResponseBody("application/json".toMediaType())
        assertTrue(friendlyError(HttpException(Response.error<Unit>(422, body))).contains("WILDSTRING_PODCAST_ALLOW_FAKE_IP"))
        val other = """{"detail":"invalid"}""".toResponseBody("application/json".toMediaType())
        assertTrue(friendlyError(HttpException(Response.error<Unit>(422, other))).startsWith("输入不符合服务器要求"))
    }
}
