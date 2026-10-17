package com.wildstring.app.update

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/** Deliberately has no WildString client, credentials, cookies, interceptors or server configuration. */
class ReleaseClient internal constructor(private val client: OkHttpClient = publicClient()) {
    companion object {
        internal fun publicClient(): OkHttpClient = OkHttpClient.Builder().cookieJar(CookieJar.NO_COOKIES)
            .followRedirects(false).followSslRedirects(false).cache(null)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(5, TimeUnit.MINUTES).build()
    }
    @Volatile private var call: Call? = null
    @Volatile private var cancelled = false
    fun begin() { cancelled = false }
    fun cancel() { cancelled = true; call?.cancel() }
    fun wasCancelled(): Boolean = cancelled
    fun ensureActive() { if (cancelled || Thread.currentThread().isInterrupted) throw UpdateFailure("cancelled") }
    private fun open(url: String, asset: ReleaseAsset? = null, etag: String? = null): Response {
        var target = url
        repeat(6) { hop ->
            ensureActive()
            if (!UpdatePolicy.allowedUrl(target, asset)) throw UpdateFailure("unsafe_download_url")
            val request = Request.Builder().url(target).header("User-Agent", "WildString-Android-Updater")
                .header("Accept", if (asset == null) "application/vnd.github+json" else "application/octet-stream")
            if (asset == null) { request.header("X-GitHub-Api-Version", "2022-11-28"); etag?.let { request.header("If-None-Match", it) } }
            val current = client.newCall(request.build()); call = current
            val response = try { current.execute() } catch (_: IOException) { ensureActive(); throw UpdateFailure("network_failed") }
            if (response.code in setOf(301, 302, 303, 307, 308)) {
                val destination = response.header("Location")?.let { response.request.url.resolve(it)?.toString() }; response.close()
                if (hop == 5 || destination == null || !UpdatePolicy.allowedUrl(destination, asset)) throw UpdateFailure("unsafe_download_url")
                target = destination
            } else return response
        }
        throw UpdateFailure("unsafe_download_url")
    }
    data class Metadata(val body: String?, val etag: String?)
    fun latest(etag: String?): Metadata = open(UpdatePolicy.LATEST, etag = etag).use { response ->
        if (response.code == 304) return@use Metadata(null, response.header("ETag") ?: etag)
        requireResponse(response)
        Metadata(read(response, UpdatePolicy.MAX_METADATA).toString(Charsets.UTF_8), response.header("ETag"))
    }
    fun checksums(asset: ReleaseAsset): String = open(asset.url, asset).use { response -> requireResponse(response); read(response, 128 * 1024).toString(Charsets.UTF_8) }
    fun download(asset: ReleaseAsset, destination: File, progress: (Long, Long) -> Unit) {
        open(asset.url, asset).use { response ->
            requireResponse(response)
            val body = response.body ?: throw UpdateFailure("download_invalid")
            if (body.contentLength() >= 0 && body.contentLength() != asset.size) throw UpdateFailure("download_invalid")
            body.byteStream().use { input -> destination.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024); var count = 0L
                while (true) { ensureActive(); val read = input.read(buffer); if (read < 0) break; count += read
                    if (count > asset.size || count > UpdatePolicy.MAX_APK) throw UpdateFailure("download_invalid")
                    output.write(buffer, 0, read); progress(count, asset.size)
                }
                if (count != asset.size) throw UpdateFailure("download_invalid")
            } }
        }
    }
    private fun requireResponse(response: Response) {
        if (response.code in setOf(403, 429)) throw UpdateFailure("github_rate_limit")
        if (!response.isSuccessful) throw UpdateFailure("github_unavailable")
    }
    private fun read(response: Response, maximum: Long): ByteArray {
        val body = response.body ?: throw UpdateFailure("release_invalid")
        if (body.contentLength() > maximum) throw UpdateFailure("response_too_large")
        val output = ByteArrayOutputStream()
        body.byteStream().use { input -> val buffer = ByteArray(8192); while (true) { ensureActive(); val count = input.read(buffer); if (count < 0) break
            if (output.size().toLong() + count > maximum) throw UpdateFailure("response_too_large")
            output.write(buffer, 0, count)
        } }
        return output.toByteArray()
    }
}
