package com.wildstring.app.data

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

fun podcastEpisodeId(trackId: String?): String? =
    trackId?.takeIf { it.startsWith("podcast_ep_") }?.removePrefix("podcast_ep_")?.takeIf { it.isNotBlank() }

fun podcastArtworkUrl(value: String): String? = value.toHttpUrlOrNull()
    ?.takeIf { it.username.isEmpty() && it.password.isEmpty() }?.toString()

/** Public RSS artwork must never use the authenticated server connection or its cookies. */
fun podcastArtworkClient(): OkHttpClient = OkHttpClient.Builder()
    .cookieJar(CookieJar.NO_COOKIES)
    .connectTimeout(15, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
    .build()

data class PodcastTimestamp(val start: Int, val end: Int, val positionMs: Long)

/** MM:SS (including minutes over 59), or HH:MM:SS. Offsets refer to rendered article text. */
fun podcastTimestamps(text: CharSequence, durationMs: Long = 0): List<PodcastTimestamp> =
    Regex("(?<![\\d:])(?:(\\d{1,2}):)?(\\d{1,3}):([0-5]\\d)(?![\\d:])").findAll(text).mapNotNull { match ->
        val hours = match.groupValues[1].toLongOrNull()
        val minutes = match.groupValues[2].toLong()
        if (hours != null && minutes > 59) return@mapNotNull null
        val time = ((hours ?: 0) * 3600 + minutes * 60 + match.groupValues[3].toLong()) * 1000
        if (durationMs > 0 && time >= durationMs) null
        else PodcastTimestamp(match.range.first, match.range.last + 1, time)
    }.toList()

fun podcastResumePosition(episode: PodcastEpisode): Long = if (episode.completed) 0 else
    (episode.positionSeconds.toLong() * 1000).coerceAtLeast(0).let { position ->
        if (episode.durationSeconds > 0) position.coerceAtMost(episode.durationSeconds * 1000L) else position
    }

fun podcastPublishedMillis(value: String): Long =
    runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
        ?: runCatching { ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() }.getOrDefault(0)
