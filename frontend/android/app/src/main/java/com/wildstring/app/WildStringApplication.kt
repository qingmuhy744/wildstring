package com.wildstring.app

import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import androidx.room.Room
import coil.ImageLoader
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.HiltAndroidApp
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import com.wildstring.app.data.*
import com.wildstring.app.diagnostics.CrashHandler
import java.util.concurrent.TimeUnit
import javax.inject.Singleton
import okhttp3.OkHttpClient

@HiltAndroidApp
class WildStringApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashHandler.install(this)
        restoreClassicLauncher()
    }

    /** People who picked the removed red icon disabled ClassicIcon. Turn that entry back on first. */
    private fun restoreClassicLauncher() {
        val manager = packageManager
        val classic = ComponentName(this, "com.wildstring.app.ClassicIcon")
        val red = ComponentName(this, "com.wildstring.app.RedClothIcon")
        runCatching {
            manager.setComponentEnabledSetting(classic, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
            manager.setComponentEnabledSetting(red, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
        }
    }
}
@Module @InstallIn(SingletonComponent::class)
object ApplicationModule {
    @Provides @Singleton fun client(session: SessionStore, cache: ClientCache): OkHttpClient = OkHttpClient.Builder()
        .cookieJar(okhttp3.CookieJar.NO_COOKIES)
        .addInterceptor(OriginGuard({ session.endpoint }, profile = session::cacheScope, unauthorized = session::invalidate))
        .addInterceptor(ScopedSessionInterceptor(session::requestState, session::cookieFor, session::cookieFrom))
        .addInterceptor(CoverCacheInterceptor(cache, session))
        .addInterceptor(AgentTimeoutInterceptor())
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).cache(null).build()
    @Provides @Singleton fun database(@ApplicationContext context: Context): QueueDatabase =
        Room.databaseBuilder(context, QueueDatabase::class.java, "playback.db").addMigrations(QueueDatabase.MIGRATION_1_2).build()
    @Provides @Singleton fun images(@ApplicationContext context: Context, client: OkHttpClient): ImageLoader =
        ImageLoader.Builder(context).okHttpClient(client).diskCache(null).build()
}
