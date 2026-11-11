package com.wildstring.app

import android.content.Context
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import coil.request.ErrorResult
import coil.request.ImageRequest
import coil.request.SuccessResult
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class ArtworkNetworkTest {
    /** Local artwork must work on a disposable device even without a registered network. */
    @Suppress("DEPRECATION")
    @Test fun coldArtworkLoadsFromLoopbackWithoutASystemNetwork() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(
            instrumentation.uiAutomation.executeShellCommand(command),
        ).use { String(it.readBytes()).trim() }
        val wifi = shell("settings get global wifi_on") == "1"
        val data = shell("settings get global mobile_data") == "1"
        val loader = ApplicationModule.images(context, OkHttpClient.Builder().cache(null).build())
        try {
            shell("svc wifi disable")
            shell("svc data disable")
            val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val deadline = SystemClock.elapsedRealtime() + 10_000
            while (connectivity.allNetworks.isNotEmpty() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50)
            assertTrue("The regression requires no registered Android network", connectivity.allNetworks.isEmpty())
            MockWebServer().use { server ->
                val bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
                val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
                bitmap.recycle()
                server.enqueue(MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(bytes)))
                server.start()
                val result = runBlocking {
                    loader.execute(ImageRequest.Builder(context).data(server.url("/cover").toString()).size(96).allowHardware(false).build())
                }
                assertTrue("Reachable local artwork must load: ${(result as? ErrorResult)?.throwable}", result is SuccessResult)
                assertNotNull("A cold cover must reach the local server", server.takeRequest(1, TimeUnit.SECONDS))
            }
        } finally {
            loader.shutdown()
            shell("svc data ${if (data) "enable" else "disable"}")
            shell("svc wifi ${if (wifi) "enable" else "disable"}")
        }
    }
}
