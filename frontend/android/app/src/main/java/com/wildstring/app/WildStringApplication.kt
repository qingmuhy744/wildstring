package com.wildstring.app

import android.app.Application
import android.content.Context
import androidx.room.Room
import coil.ImageLoader
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.HiltAndroidApp
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import com.wildstring.app.data.*
import java.util.concurrent.TimeUnit
import javax.inject.Singleton
import okhttp3.OkHttpClient

@HiltAndroidApp
class WildStringApplication : Application()
@Module @InstallIn(SingletonComponent::class)
object ApplicationModule {
    @Provides @Singleton fun client(session: SessionStore, cache: ClientCache): OkHttpClient = OkHttpClient.Builder()
        .cookieJar(SessionCookieJar(session) { session.endpoint })
        .addInterceptor(OriginGuard({ session.endpoint }, profile = session::cacheScope, unauthorized = session::invalidate))
        .addInterceptor(CoverCacheInterceptor(cache, session))
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).cache(null).build()
    @Provides @Singleton fun database(@ApplicationContext context: Context): QueueDatabase =
        Room.databaseBuilder(context, QueueDatabase::class.java, "playback.db").build()
    @Provides @Singleton fun images(@ApplicationContext context: Context, client: OkHttpClient): ImageLoader =
        ImageLoader.Builder(context).okHttpClient(client).diskCache(null).build()
}
