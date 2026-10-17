package com.wildstring.app

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer

/** Match AudioResponse and an initial AAC encoding response, including bodyless HEAD. */
internal fun audioStreamFixture(request: RecordedRequest, bytes: ByteArray, type: String, etag: String,
    encoding: Boolean = false): MockResponse {
    val response = MockResponse().setHeader("Content-Type", type).setHeader("Accept-Ranges", if (encoding) "none" else "bytes")
    if (!encoding) response.setHeader("ETag", etag)
    if (request.method == "HEAD") {
        if (!encoding) response.setHeader("Content-Length", bytes.size)
        else response.removeHeader("Content-Length")
        return response
    }
    if (encoding) return response.setChunkedBody(Buffer().write(bytes), 4096)
    val range = request.getHeader("Range")?.takeIf { request.getHeader("If-Range") in listOf(null, etag) }
    val start = range?.substringAfter("bytes=")?.substringBefore('-')?.toIntOrNull() ?: 0
    val end = range?.substringAfter('-')?.toIntOrNull()?.coerceAtMost(bytes.lastIndex) ?: bytes.lastIndex
    if (start !in bytes.indices || end < start) return response.setResponseCode(416).setHeader("Content-Range", "bytes */${bytes.size}")
    response.setBody(Buffer().write(bytes, start, end - start + 1))
    if (range != null) response.setResponseCode(206).setHeader("Content-Range", "bytes $start-$end/${bytes.size}")
    return response
}
