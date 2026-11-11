package com.wildstring.app.data

import coil.ImageLoader
import coil.intercept.Interceptor
import coil.request.ErrorResult
import coil.request.ImageResult

data class PodcastArtwork(val source: String?, val server: String, val serverFirst: Boolean = false)

/** Public RSS requests use no session; only the fallback uses the authenticated server loader. */
class PodcastArtworkFallback(private val serverLoader: ImageLoader) : Interceptor {
    override suspend fun intercept(chain: Interceptor.Chain): ImageResult {
        val artwork = chain.request.data as? PodcastArtwork ?: return chain.proceed(chain.request)
        if (artwork.serverFirst || artwork.source == null) {
            val server = serverLoader.execute(chain.request.newBuilder().data(artwork.server).build())
            if (server !is ErrorResult || artwork.source == null) return server
            return chain.proceed(chain.request.newBuilder().data(artwork.source).build())
        }
        val direct = chain.proceed(chain.request.newBuilder().data(artwork.source).build())
        if (direct !is ErrorResult) return direct
        return serverLoader.execute(chain.request.newBuilder().data(artwork.server).build())
    }
}
