package com.wildstring.app.playback

import androidx.media3.common.PlaybackException
import androidx.media3.datasource.HttpDataSource

private const val PODCAST_GENERIC = "无法播放本期播客，请检查连接或音频格式后重试。"
private const val TRACK_GENERIC = "无法播放这首歌，请检查连接或音频编码后重试。"
private const val PODCAST_UPSTREAM = "播客源站暂时无法连接，请稍后重试；若持续失败请检查服务端网络或出站代理。"
private const val PODCAST_FAKE_IP = "服务端 DNS 处于 fake-ip 模式，请在服务端配置出站代理或开启 WILDSTRING_PODCAST_ALLOW_FAKE_IP。"

/** Turns a player error into user text, using the server's error code when the stream returned one. */
fun playbackErrorMessage(error: PlaybackException, podcast: Boolean): String {
    val chain = generateSequence<Throwable>(error) { it.cause }
    chain.filterIsInstance<PlaybackResolutionException>().firstOrNull()?.message?.let { return it }
    val http = chain.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()
    if (!podcast) return trackPlaybackMessage(http?.responseCode, http?.responseBody?.decodeToString().orEmpty())
    return podcastPlaybackMessage(http?.responseCode, http?.responseBody?.decodeToString().orEmpty(),
        http == null && error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)
}

/** Pure mapping so JVM tests can cover it without Media3's Android clock. */
fun podcastPlaybackMessage(responseCode: Int?, body: String, badHttpStatus: Boolean): String = when {
    "remote_url_fake_ip" in body -> PODCAST_FAKE_IP
    "podcast_audio_upstream_failed" in body || responseCode == 502 -> PODCAST_UPSTREAM
    responseCode == 416 -> "播放位置超出了本期音频的范围，请从头播放。"
    badHttpStatus -> PODCAST_UPSTREAM
    else -> PODCAST_GENERIC
}

/** Network failures never imply a permanently missing track. */
fun trackPlaybackMessage(responseCode: Int?, body: String): String = when {
    "audio_not_found" in body -> "音频文件缺失，请恢复文件并重新扫描后重试。"
    "track_unavailable" in body -> "音频文件暂不可用，请恢复文件并重新扫描后重试。"
    "file_changed_rescan_required" in body -> "音频文件已变化，请重新扫描后重试。"
    "audio_unavailable" in body -> "服务端无法读取音频文件，请检查存储后重试。"
    responseCode == 401 -> "登录已失效，请重新登录。"
    responseCode == 404 -> "音频文件不存在或已移除，请刷新曲库后重试。"
    responseCode == 409 -> "音频文件已变化或无法读取，请检查服务端存储并重新扫描。"
    else -> TRACK_GENERIC
}
