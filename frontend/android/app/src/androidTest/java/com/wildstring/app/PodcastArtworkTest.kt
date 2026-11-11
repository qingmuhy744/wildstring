package com.wildstring.app

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import coil.ImageLoader
import coil.request.ErrorResult
import coil.request.ImageRequest
import coil.request.SuccessResult
import com.wildstring.app.data.PodcastArtwork
import com.wildstring.app.data.PodcastArtworkFallback
import com.wildstring.app.data.podcastArtworkClient
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class PodcastArtworkTest {
    @Test fun reachableSourceDoesNotUseServerFallback() = verify(source = "image", serverStatus = 200, fallback = false)
    @Test fun failedSourceUsesAuthenticatedServerOnce() = verify(source = "error", serverStatus = 200, fallback = true)
    @Test fun invalidSourceImageUsesServerFallback() = verify(source = "invalid", serverStatus = 200, fallback = true)
    @Test fun failedSourceAndServerStopWithoutRetrying() = verify(source = "error", serverStatus = 502, fallback = true)
    @Test fun serverPreferenceDoesNotContactHealthySource() = verify(source = "image", serverStatus = 200, fallback = true, serverFirst = true)
    @Test fun failedPreferredServerUsesPublicSource() = verify(source = "image", serverStatus = 502, fallback = true, serverFirst = true)
    @Test fun missingSourceUsesServerDirectly() = verify(source = "missing", serverStatus = 200, fallback = true)

    private fun verify(source: String, serverStatus: Int, fallback: Boolean, serverFirst: Boolean = false) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        bitmap.recycle()
        MockWebServer().use { origin ->
            MockWebServer().use { server ->
                origin.start(); server.start()
                origin.enqueue(when (source) {
                    "image" -> MockResponse().setBody(Buffer().write(bytes)).setHeader("Content-Type", "image/png")
                    "invalid" -> MockResponse().setBody("not an image")
                    else -> MockResponse().setResponseCode(503)
                })
                server.enqueue(MockResponse().setResponseCode(serverStatus).setHeader("Content-Type", "image/png").setBody(Buffer().write(bytes)))
                val serverClient = OkHttpClient.Builder().addInterceptor { chain ->
                    chain.proceed(chain.request().newBuilder().header("Cookie", "wildstring_session=synthetic-test-session").build())
                }.build()
                val serverLoader = ApplicationModule.images(context, serverClient)
                val publicLoader = ImageLoader.Builder(context).okHttpClient(podcastArtworkClient())
                    .components { add(PodcastArtworkFallback(serverLoader)) }
                    .networkObserverEnabled(false).diskCache(null).build()
                try {
                    val result = runBlocking {
                        publicLoader.execute(ImageRequest.Builder(context)
                            .data(PodcastArtwork(origin.url("/art.png").toString().takeUnless { source == "missing" }, server.url("/api/v1/podcasts/show/cover").toString(), serverFirst))
                            .size(96).build())
                    }
                    if (serverStatus == 200 || source == "image") assertTrue("${(result as? ErrorResult)?.throwable}", result is SuccessResult)
                    else assertTrue(result is ErrorResult)
                    val sourceRequested = source != "missing" && !(serverFirst && serverStatus == 200)
                    assertEquals(if (sourceRequested) 1 else 0, origin.requestCount)
                    if (sourceRequested) {
                        val direct = origin.takeRequest(1, TimeUnit.SECONDS)!!
                        assertNull(direct.getHeader("Cookie"))
                        assertNull(direct.getHeader("Authorization"))
                    }
                    assertEquals(if (fallback) 1 else 0, server.requestCount)
                    if (fallback) assertEquals("wildstring_session=synthetic-test-session", server.takeRequest(1, TimeUnit.SECONDS)!!.getHeader("Cookie"))
                } finally {
                    publicLoader.shutdown(); serverLoader.shutdown()
                }
            }
        }
    }
}
