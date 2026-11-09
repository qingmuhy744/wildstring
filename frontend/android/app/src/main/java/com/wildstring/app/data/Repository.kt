package com.wildstring.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import java.io.IOException
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton
import dagger.hilt.android.qualifiers.ApplicationContext
import okhttp3.OkHttpClient
import okhttp3.CookieJar
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.asSharedFlow
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

const val DISCOVERY_CACHE_TTL = 3600_000L

data class CatalogQuery(val tab: String = "search", val kind: String = "discover", val title: String = AppLanguage.string(R.string.repo_tab_discover),
    val query: String = "", val offset: Int = 0, val collection: String? = null, val collectionId: String? = null,
    val playlist: Playlist? = null, val role: String = "album_artist", val sort: String = "title", val albumFilter: String? = null, val order: String = "asc",
    val libraryId: String = "all") {
    val indexed: Boolean get() = kind in listOf("tracks", "albums", "artists") && sort in listOf("title", "name") && order == "asc" &&
        collection != "playlists" && collection != "albums" && albumFilter == null
    val key: String get() = Gson().toJson(listOf(tab, kind, query, offset, collection, collectionId, role, sort, albumFilter, order, libraryId))
}
data class CatalogPage(val tracks: List<Track> = emptyList(), val albums: List<Album> = emptyList(),
    val artists: List<Artist> = emptyList(), val playlists: List<Playlist> = emptyList(), val total: Int = 0, val discs: List<DiscSummary>? = null,
    val addedTracks: List<Track>? = null)

@Singleton
class Repository @Inject constructor(@param:ApplicationContext private val context: Context, val session: SessionStore, val client: OkHttpClient, val database: QueueDatabase, val cache: ClientCache, val settings: AppSettings, val downloads: OfflineDownloads) {
    val connectionRoutes = ServerRouteManager(session)
    private val preferenceScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + Dispatchers.Main.immediate)
    init {
        preferenceScope.launch { connectionRoutes.monitor() }
        settings.bindAccount(session.activeServerId, session.account?.id)
        preferenceScope.launch {
            session.profiles.collect { settings.bindAccount(session.activeServerId, session.account?.id) }
        }
    }
    private val gson = Gson()
    private val libraryPrefs = context.getSharedPreferences("music-libraries", Context.MODE_PRIVATE)
    val selectedLibraryId: String get() = libraryPrefs.getString("selected:${session.storageScope()}", "all") ?: "all"
    fun selectLibrary(id: String) { session.storageScope()?.let { libraryPrefs.edit().putString("selected:$it", id).apply() } }
    private val accessChanges = kotlinx.coroutines.flow.MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val libraryAccessChanges = accessChanges.asSharedFlow()
    @Volatile private var libraryAccessFingerprint = ""
    @Volatile private var fingerprintOwner: String? = null
    private fun libraryInterceptor(owner: String, selection: String) = okhttp3.Interceptor { chain ->
        val response = chain.proceed(chain.request().newBuilder().header("X-Wildstring-Library", selection).build())
        if (owner == session.cacheScope()) response.header("X-Wildstring-Library-Access")?.let { fingerprint ->
            synchronized(this) {
                if (fingerprintOwner == owner && libraryAccessFingerprint.isNotEmpty() && libraryAccessFingerprint != fingerprint) accessChanges.tryEmit(Unit)
                libraryAccessFingerprint = fingerprint; fingerprintOwner = owner
            }
        }
        response
    }
    private var cachedUrl: String? = null
    private var cachedApi: Api? = null
    private var cachedAgentKey: String? = null
    private var cachedAgentApi: Api? = null
    val knownTracks = java.util.concurrent.ConcurrentHashMap<String, Track>()
    private val favoriteClock = java.util.concurrent.atomic.AtomicLong()
    private val favoriteVersions = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val discoveryCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, PodcastDirectoryPage>>()
    val podcastFavoriteIds = kotlinx.coroutines.flow.MutableStateFlow<Set<String>>(emptySet())

    fun cachedPodcastDirectory(region: String = ""): PodcastDirectoryPage? {
        val key = region.trim()
        val entry = discoveryCache[key] ?: return null
        if (System.currentTimeMillis() - entry.first < DISCOVERY_CACHE_TTL) {
            return entry.second
        }
        discoveryCache.remove(key)
        return null
    }

    fun isPodcastEpisodeFavorite(episodeId: String): Boolean = podcastFavoriteIds.value.contains(episodeId)
    @Synchronized private fun rememberTrack(track: Track, snapshot: Long? = null): Track {
        val previous = knownTracks[track.id]
        val merged = if (previous != null && (snapshot == null || (favoriteVersions[track.id] ?: 0L) > snapshot))
            track.copy(loved = previous.loved) else track
        knownTracks[track.id] = merged
        return merged
    }
    fun rememberPlaybackTrack(track: Track): Track = rememberTrack(track)
    @Synchronized private fun favoriteChanged(id: String) { favoriteVersions[id] = favoriteClock.incrementAndGet() }
    @Synchronized fun publishFavorite(track: Track): Track {
        favoriteChanged(track.id)
        return (knownTracks[track.id] ?: track).copy(loved = track.loved).also { knownTracks[track.id] = it }
    }
    @Synchronized fun api(): Api {
        val request = session.requestState() ?: throw IOException(AppLanguage.string(R.string.repo_connect_server_first))
        val base = request.endpoint
        val selection = request.selection
        val library = selectedLibraryId
        val key = "$base|$selection|$library"
        if (cachedUrl != key) {
            val scoped = client.newBuilder().apply {
                interceptors().add(0, SelectionRequestInterceptor(selection) { session.requestState()?.selection })
                addInterceptor(libraryInterceptor(session.cacheScope().orEmpty(), library))
            }.build()
            cachedApi = Retrofit.Builder().baseUrl(base).client(scoped).addConverterFactory(GsonConverterFactory.create(networkGson())).build().create(Api::class.java)
            cachedUrl = key
        }
        return checkNotNull(cachedApi)
    }
    /** A lost assistant response can already have consumed model budget; do not resend POSTs. */
    @Synchronized fun agentApi(): Api {
        val request = session.requestState() ?: throw IOException(AppLanguage.string(R.string.repo_connect_server_first))
        val library = selectedLibraryId
        val key = "${request.endpoint}|${request.selection}|$library"
        if (cachedAgentKey != key) {
            val scoped = client.newBuilder().retryOnConnectionFailure(false).apply {
                interceptors().add(0, SelectionRequestInterceptor(request.selection) { session.requestState()?.selection })
                addInterceptor(libraryInterceptor(session.cacheScope().orEmpty(), library))
            }.build()
            cachedAgentApi = Retrofit.Builder().baseUrl(request.endpoint).client(scoped)
                .addConverterFactory(GsonConverterFactory.create(networkGson())).build().create(Api::class.java)
            cachedAgentKey = key
        }
        return checkNotNull(cachedAgentApi)
    }
    fun url(vararg segments: String): String {
        val builder = (session.endpoint ?: throw IOException(AppLanguage.string(R.string.repo_connect_server_first))).newBuilder()
        segments.forEach { builder.addPathSegment(it) }
        return builder.build().toString()
    }
    val podcastImageClient: OkHttpClient = podcastArtworkClient().newBuilder()
        .addInterceptor(CoverCacheInterceptor(cache, session) { true }).build()
    fun cover(id: String): String =
        knownTracks[id]?.podcast?.coverUrl?.let(::podcastArtworkUrl)
            ?: (url("api", "v1", "tracks", id, "cover") + "?size=768")
    fun imageClient(uri: String): OkHttpClient = if (knownTracks.values.any {
        it.podcast?.coverUrl?.let(::podcastArtworkUrl) == uri
    }) podcastImageClient else client
    suspend fun coverImage(id: String): ByteArray = withContext(Dispatchers.IO) {
        val owner = session.cacheScope(); requireProfile(owner)
        val bytes = api().coverImage(cover(id), RequestOwner(owner!!)).use { body ->
            body.byteStream().use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > 4 * 1024 * 1024) throw IOException(AppLanguage.string(R.string.repo_cover_too_large))
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
        }
        requireProfile(owner)
        if (bytes.size < 3 || bytes[0] != 0xff.toByte() || bytes[1] != 0xd8.toByte()) throw IOException(AppLanguage.string(R.string.repo_cover_unavailable))
        bytes
    }
    private fun podcastNetwork(): String {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val caps = manager.getNetworkCapabilities(manager.activeNetwork)
        return when {
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true || caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true -> "wifi"
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "cellular"
            else -> "unknown"
        }
    }
    fun originalStream(id: String): String =
        if (id.startsWith("podcast_ep_")) {
            url("api", "v1", "podcasts", "episodes", id.removePrefix("podcast_ep_"), "stream") + "?proxy=1&cache=1&network=${podcastNetwork()}"
        } else {
            url("api", "v1", "tracks", id, "stream")
        }
    fun stream(id: String): String = PlaybackRequest.url(originalStream(id), if (podcastEpisodeId(id) != null || downloads.file(id) != null) 0 else settings.state.value.aacBitrate)

    suspend fun podcasts(): List<PodcastSummary> = api().podcasts(if (session.account?.profile in listOf("owner", "librarian")) null else true)
    suspend fun libraries(includeDisabled: Boolean = false): List<MusicLibrary> {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().libraries(includeDisabled).also { requireProfile(owner) }
    }
    suspend fun followPodcast(id: String, followed: Boolean): Boolean {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().followPodcast(id, PodcastFollow(followed), RequestOwner(owner)).also { requireProfile(owner) }.followed
    }
    suspend fun podcastPublishers(): List<PodcastPublisher> {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastPublishers(RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun podcastPublisher(id: String): PodcastPublisherDetail {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastPublisher(id, RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun assignPodcastPublisher(id: String, body: PodcastPublisherAssignment): PodcastDetail {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().assignPodcastPublisher(id, body, RequestOwner(owner)).also {
            requireProfile(owner); save("podcast:$id", it, owner)
        }
    }
    suspend fun savePodcastEpisode(id: String, saved: Boolean): PodcastSaveResult {
        val owner = session.cacheScope()
        return (if (saved) api().savePodcastEpisode(id, RequestOwner(owner)) else api().releasePodcastEpisode(id, RequestOwner(owner))).also { requireProfile(owner) }
    }
    suspend fun podcastCatalogPolicy(): PodcastCatalogPolicy {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastCatalogPolicy(RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun subscribePodcast(feedUrl: String, itunesId: String? = null): PodcastDetail {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().subscribePodcast(PodcastSubscribeRequest(feedUrl, itunesId), RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun podcastDirectory(query: String, region: String, forceRefresh: Boolean = false): PodcastDirectoryPage {
        val trimmedQuery = query.trim()
        if (trimmedQuery.isBlank() && !forceRefresh) {
            cachedPodcastDirectory(region)?.let { return it }
        }
        val parameters = if (trimmedQuery.isNotBlank()) mapOf("q" to trimmedQuery) else if (region.isNotEmpty()) mapOf("region" to region) else emptyMap()
        val data = feature(if (trimmedQuery.isBlank()) "podcasts/discover" else "podcasts/search", query = parameters)
        val page = gson.fromJson(data, PodcastDirectoryPage::class.java)
        if (trimmedQuery.isBlank()) {
            discoveryCache[region.trim()] = Pair(System.currentTimeMillis(), page)
        }
        return page
    }
    suspend fun previewPodcast(feedUrl: String): PodcastFeedPreview {
        val data = feature("podcasts/preview", "POST", com.google.gson.JsonObject().apply { addProperty("feed_url", feedUrl) })
        return gson.fromJson(data, PodcastFeedPreview::class.java)
    }
    suspend fun podcastDetail(id: String): PodcastDetail {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastDetail(id).also { detail ->
            requireProfile(owner); save("podcast:$id", detail, owner)
        }
    }
    suspend fun cachedPodcastDetail(id: String): PodcastDetail? = saved("podcast:$id", PodcastDetail::class.java)
    suspend fun cachedPodcastEpisode(id: String): PodcastEpisode? = saved("podcast-episode:$id", PodcastEpisode::class.java)
    /** Daily picks depend on the selected library, so each library keeps its own cached batch. */
    suspend fun daily(refresh: Boolean = false): DailyRecommendations {
        val owner = session.cacheScope(); requireProfile(owner)
        val key = "recommendations:daily:$selectedLibraryId"
        return agentApi().run { if (refresh) refreshDaily() else daily() }.also { daily ->
            requireProfile(owner); save(key, daily, owner)
        }
    }
    suspend fun cachedDaily(): DailyRecommendations? = saved("recommendations:daily:$selectedLibraryId", DailyRecommendations::class.java)
    suspend fun podcastEpisode(id: String): PodcastEpisode {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastEpisode(id).also { episode ->
            requireProfile(owner); save("podcast-episode:$id", episode, owner)
        }
    }
    suspend fun rememberPodcastEpisode(episode: PodcastEpisode, podcast: PodcastSummary): Track {
        val owner = session.cacheScope(); requireProfile(owner)
        val track = episode.toTrack(podcast)
        save("track:${track.id}", track, owner)
        save("podcast-episode:${episode.id}", episode, owner)
        requireProfile(owner)
        return rememberTrack(track)
    }
    suspend fun refreshPodcast(id: String): PodcastDetail {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().refreshPodcast(id).also { detail ->
            requireProfile(owner); save("podcast:$id", detail, owner)
        }
    }
    suspend fun refreshAllPodcasts(): Boolean = try { api().refreshAllPodcasts(); true }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { false }
    suspend fun deletePodcast(id: String): Boolean = api().deletePodcast(id).isSuccessful
    suspend fun podcastDownloadSettings(id: String): PodcastDownloadSettings {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastDownloadSettings(id, RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun updatePodcastDownloadSettings(id: String, settings: PodcastDownloadSettings, expectedOwner: String? = session.cacheScope()): PodcastDownloadSettings {
        val owner = expectedOwner; requireProfile(owner)
        return api().updatePodcastDownloadSettings(id, PodcastDownloadSettingsUpdate(settings.version, settings.downloadPolicy, settings.retentionPolicy), RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun updatePodcastServerSettings(id: String, slowDownload: Boolean, maxRetries: Int, retryBackoffBase: Int, expectedOwner: String? = session.cacheScope()): PodcastDetail {
        val owner = expectedOwner; requireProfile(owner)
        return api().updatePodcastServerSettings(id, PodcastServerSettingsUpdate(slowDownload, maxRetries, retryBackoffBase), RequestOwner(owner)).also { detail ->
            requireProfile(owner); save("podcast:$id", detail, owner)
        }
    }
    suspend fun podcastDownloadQueue(): PodcastDownloadQueueInfo {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastDownloadQueue(RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun retryFailedPodcastDownloads(): PodcastRetryFailedResult {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().retryFailedPodcastDownloads(RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun clearCompletedPodcastDownloads() {
        val owner = session.cacheScope(); requireProfile(owner)
        api().clearCompletedPodcastDownloads(RequestOwner(owner))
        requireProfile(owner)
    }
    suspend fun podcastPlaybackSettings(): PodcastPlaybackSettings {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastPlaybackSettings(RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun updatePodcastPlaybackSettings(settings: PodcastPlaybackSettings, expectedOwner: String? = session.cacheScope()): PodcastPlaybackSettings {
        val owner = expectedOwner; requireProfile(owner)
        if (settings.userId != session.account?.id) throw CancellationException(AppLanguage.string(R.string.repo_session_changed))
        return api().updatePodcastPlaybackSettings(PodcastPlaybackSettingsUpdate(settings.version, settings.autoCacheCurrent, settings.prefetchNext, settings.networkPolicy), RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun podcastInbox(): PodcastInboxSnapshot {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastInbox(RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun addPodcastInbox(episodeId: String): PodcastInboxWriteResult {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().addPodcastInboxItem(episodeId, com.google.gson.JsonObject(), RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun removePodcastInbox(episodeId: String): PodcastInboxWriteResult {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().removePodcastInboxItem(episodeId, RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun podcastQueue(): PodcastQueueSnapshot {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastQueue(RequestOwner(owner)).normalized().also { requireProfile(owner) }
    }
    suspend fun replacePodcastQueue(version: Int, deviceId: String, items: List<PodcastQueueItem>): PodcastQueueSnapshot {
        val owner = session.cacheScope(); requireProfile(owner)
        return try {
            api().replacePodcastQueue(PodcastQueueUpdate(version, deviceId, podcastQueueNormalize(items)), RequestOwner(owner)).normalized().also { requireProfile(owner) }
        } catch (error: HttpException) {
            if (error.code() == 409) podcastQueueConflict(error)?.let { throw it }
            throw error
        }
    }
    suspend fun podcastQueuePreferences(): PodcastQueuePreferences {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastQueuePreferences(RequestOwner(owner)).forUpload().also { requireProfile(owner) }
    }
    suspend fun savePodcastQueuePreferences(body: PodcastQueuePreferences): PodcastQueuePreferences {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().savePodcastQueuePreferences(body.forUpload(), RequestOwner(owner)).forUpload().also { requireProfile(owner) }
    }
    suspend fun favoritePodcastEpisode(episodeId: String, loved: Boolean): PodcastFavoriteResponse {
        val owner = session.cacheScope(); requireProfile(owner)
        val response = api().favoritePodcastEpisode(episodeId, PodcastFavoriteRequest(favorite = loved, loved = loved), RequestOwner(owner))
        if (loved) podcastFavoriteIds.value = podcastFavoriteIds.value + episodeId else podcastFavoriteIds.value = podcastFavoriteIds.value - episodeId
        cachedPodcastEpisode(episodeId)?.let { ep ->
            val updated = ep.copy(loved = loved, favorite = loved)
            save("podcast-episode:$episodeId", updated, owner)
        }
        val cachedEp = cachedPodcastEpisode(episodeId)
        val podcastId = cachedEp?.podcastId
        if (podcastId != null) {
            cachedPodcastDetail(podcastId)?.let { detail ->
                val updatedDetail = detail.copy(episodes = detail.episodes.map { if (it.id == episodeId) it.copy(loved = loved, favorite = loved) else it })
                save("podcast:$podcastId", updatedDetail, owner)
            }
        }
        requireProfile(owner)
        return response
    }
    suspend fun getPodcastFavoriteIds(): Set<String> {
        val owner = session.cacheScope(); requireProfile(owner)
        return try {
            val ids = api().podcastFavoriteIds(RequestOwner(owner)).ids.toSet()
            podcastFavoriteIds.value = ids
            requireProfile(owner)
            ids
        } catch (_: Exception) {
            podcastFavoriteIds.value
        }
    }
    suspend fun savePodcastProgress(episodeId: String, completed: Boolean, durationSeconds: Int = 0): EpisodeProgress {
        val owner = session.cacheScope(); requireProfile(owner)
        val current = try { api().podcastProgress(episodeId, RequestOwner(owner)) } catch (_: Exception) { null }
        val baseVersion = current?.version ?: 0L
        val currentDuration = current?.durationSeconds?.toInt() ?: 1
        val effectiveDuration = maxOf(1, if (durationSeconds > 0) durationSeconds else currentDuration)
        val position = if (completed) effectiveDuration else 0
        val event = if (completed) "ended" else "stop"
        val sessionToken = "manual-" + java.util.UUID.randomUUID().toString()
        val write = PodcastProgressUpdate(
            sessionId = sessionToken,
            deviceId = "wildstring-android",
            baseVersion = baseVersion,
            sequence = 1,
            positionSeconds = position.toLong(),
            durationSeconds = effectiveDuration.toLong(),
            event = event,
        )
        val result = api().updatePodcastProgress(episodeId, write, RequestOwner(owner))
        cachedPodcastEpisode(episodeId)?.let { ep ->
            val updated = ep.copy(completed = completed, positionSeconds = position)
            save("podcast-episode:$episodeId", updated, owner)
        }
        requireProfile(owner)
        return result
    }
    private fun podcastQueueConflict(error: HttpException): PodcastQueueConflictException? {
        val raw = error.response()?.errorBody()?.string().orEmpty()
        val parsed = runCatching { networkGson().fromJson(raw, PodcastQueueConflictEnvelope::class.java) }.getOrNull() ?: return null
        if (parsed.detail.code != "podcast_queue_conflict") return null
        return PodcastQueueConflictException(parsed.detail.current.normalized())
    }
    suspend fun checkCatalogGaps(artist: String, limit: Int = 10): com.google.gson.JsonObject {
        val payload = com.google.gson.JsonObject().apply {
            addProperty("artist", artist)
            addProperty("limit", limit)
        }
        return api().catalogGaps(payload)
    }
    suspend fun status(): AuthStatus {
        val owner = session.cacheScope()
        val endpoint = session.endpoint
        return api().status().also {
            if (owner != session.cacheScope() || endpoint != session.endpoint) throw CancellationException(AppLanguage.string(R.string.repo_session_changed))
            it.server?.let(session::updateServerInfo)
        }
    }
    suspend fun acceptAccount(account: Account?): Boolean {
        val changed = session.bindAccount(account)
        settings.bindAccount(session.activeServerId, session.account?.id)
        if (changed) {
            knownTracks.clear()
            val owner = session.cacheScope()
            withContext(Dispatchers.IO) { if (owner == session.cacheScope()) { database.queue().clear(); cache.clear(owner) } }
        }
        return changed
    }
    suspend fun updateProfile(username: String, displayName: String, email: String): Account {
        val owner = session.cacheScope() ?: throw IOException(AppLanguage.string(R.string.repo_login_expired))
        val endpoint = session.endpoint
        val account = session.account ?: throw IOException(AppLanguage.string(R.string.repo_no_account_info))
        val updated = api().updateProfile(ProfileUpdate(version = account.version, username = username, displayName = displayName, email = email))
        if (owner != session.cacheScope() || endpoint != session.endpoint) throw CancellationException(AppLanguage.string(R.string.repo_session_changed))
        session.bindAccount(updated)
        return updated
    }
    /** Saves the interface language on the account; it does not bump the profile version. */
    suspend fun updateLanguage(language: String): Account {
        val owner = session.cacheScope() ?: throw IOException(AppLanguage.string(R.string.repo_login_expired))
        val endpoint = session.endpoint
        val updated = api().updatePreferences(PreferencesUpdate(language))
        if (owner != session.cacheScope() || endpoint != session.endpoint) throw CancellationException(AppLanguage.string(R.string.repo_session_changed))
        session.bindAccount(updated)
        return updated
    }
    suspend fun changePassword(current: String, next: String) {
        val owner = session.cacheScope() ?: throw IOException(AppLanguage.string(R.string.repo_login_expired))
        val request = session.requestState() ?: throw IOException(AppLanguage.string(R.string.repo_not_connected))
        val base = request.endpoint
        val cookie = session.cookieFor(request)?.substringBefore(';') ?: throw IOException(AppLanguage.string(R.string.repo_login_expired))
        // A late password response must never clear cookies belonging to a newer login.
        val isolated = Retrofit.Builder().baseUrl(base).client(client.newBuilder().apply { interceptors().removeAll { it is ScopedSessionInterceptor }; interceptors().add(0, SelectionRequestInterceptor(request.selection) { session.requestState()?.selection }) }.cookieJar(CookieJar.NO_COOKIES).build())
            .addConverterFactory(GsonConverterFactory.create(networkGson())).build().create(Api::class.java)
        val response = isolated.changePassword(cookie, PasswordChange(current, next))
        if (owner != session.cacheScope() || base != session.endpoint) throw CancellationException(AppLanguage.string(R.string.repo_session_changed))
        if (!response.isSuccessful) throw HttpException(response)
    }
    suspend fun tracks(query: String = "", offset: Int = 0, collection: String? = null, collectionId: String? = null, recent: Boolean = false, role: String = "artist", sort: String = if (recent) "last_played_at" else "title", limit: Int = 50, albumFilter: String? = null, order: String? = null): Page<Track> {
        val profile = session.cacheScope()
        val snapshot = favoriteClock.get()
        val resource = if (collection != null && collectionId != null) url("api", "v1", collection, collectionId, "tracks") else url("api", "v1", "tracks")
        val target = resource.toHttpUrl().newBuilder().apply {
            addQueryParameter("sort", sort)
            if (order != null) addQueryParameter("order", order)
            if (recent) addQueryParameter("played_only", "true")
            if (collection == "artists") { addQueryParameter("role", role); if (albumFilter != null) addQueryParameter("album_id", albumFilter) }
        }.build().toString()
        return api().tracks(target, query, limit = limit, offset = offset).let { page -> requireProfile(profile); page.copy(items = page.items.map { rememberTrack(it, snapshot) }) }
    }
    private fun requireProfile(profile: String?) { if (profile == null || session.cacheScope() != profile) throw CancellationException(AppLanguage.string(R.string.repo_session_changed)) }
    private suspend fun <T> saved(key: String, type: Class<T>): T? {
        val owner = session.cacheScope() ?: return null
        val result = withContext(Dispatchers.IO) { cache.read(key)?.let { runCatching { gson.fromJson(String(it.bytes, Charsets.UTF_8), type) }.getOrNull() } }
        requireProfile(owner); return result
    }
    private suspend fun save(key: String, value: Any, profile: String?, revision: Long? = null) = withContext(Dispatchers.IO) { cache.put(key, gson.toJson(value).toByteArray(), profile, revision = revision) }
    suspend fun playbackGain(id: String): com.google.gson.JsonObject {
        val owner = session.cacheScope(); requireProfile(owner)
        val value = api().objectGet(url("api", "v1", "tracks", id, "playback-gain"))
        requireProfile(owner); save("playback-gain:$id", value, owner); return value
    }
    suspend fun cachedPlaybackGain(id: String): com.google.gson.JsonObject? = saved("playback-gain:$id", com.google.gson.JsonObject::class.java)
    suspend fun feature(path: String, method: String = "GET", body: com.google.gson.JsonObject = com.google.gson.JsonObject(), query: Map<String, String> = emptyMap()): com.google.gson.JsonObject {
        val owner = session.cacheScope(); requireProfile(owner)
        val target = url("api", "v1", *path.split('/').toTypedArray()).toHttpUrl().newBuilder().apply { query.forEach { (key, value) -> addQueryParameter(key, value) } }.build().toString()
        val response = when (method) {
            "POST" -> api().agentPost(target, body, if (path.endsWith("/test")) AgentRequestPolicy() else null, RequestOwner(owner!!)); "PUT" -> api().agentPut(target, body, RequestOwner(owner!!))
            "DELETE" -> api().agentDelete(target, RequestOwner(owner!!)); else -> api().agentGet(target, RequestOwner(owner!!))
        }
        requireProfile(owner)
        if (!response.isSuccessful) {
            val code = response.errorBody()?.use { runCatching {
                val error = gson.fromJson(it.string(), com.google.gson.JsonObject::class.java)
                error.objectOrNull("detail")?.text("code") ?: error.text("detail")
            }.getOrDefault("") }.orEmpty()
            throw AgentApiException(response.code(), code, diagnosticId(response.headers()["X-Wildstring-Trace-Id"]))
        }
        return response.body() ?: com.google.gson.JsonObject()
    }
    suspend fun saveAvatar(bytes: ByteArray, owner: String) {
        requireProfile(owner)
        require(bytes.size <= 5 * 1024 * 1024) { AppLanguage.string(R.string.repo_avatar_too_large) }
        val response = api().uploadAvatar(url("api", "v1", "auth", "avatar"), bytes.toRequestBody("application/octet-stream".toMediaType()), RequestOwner(owner))
        requireProfile(owner)
        if (!response.isSuccessful) {
            val code = response.errorBody()?.use { runCatching { gson.fromJson(it.string(), com.google.gson.JsonObject::class.java).text("detail") }.getOrDefault("") }.orEmpty()
            throw AgentApiException(response.code(), code, diagnosticId(response.headers()["X-Wildstring-Trace-Id"]))
        }
    }
    suspend fun cachedCatalog(query: CatalogQuery): CatalogPage? = saved("catalog:${query.key}", CatalogPage::class.java)?.let { it.copy(tracks = it.tracks.map { track -> rememberTrack(track) }) }
    private fun <T> Page<T>.checked(query: CatalogQuery): Page<T> {
        require(offset == query.offset && limit == CATALOG_PAGE_SIZE && total >= 0) { AppLanguage.string(R.string.repo_list_position_changed) }
        require(items.size == minOf(CATALOG_PAGE_SIZE, (total - offset).coerceAtLeast(0))) { AppLanguage.string(R.string.repo_list_incomplete) }
        return this
    }
    suspend fun catalog(query: CatalogQuery): CatalogPage {
        if (query.libraryId != selectedLibraryId) throw CancellationException(AppLanguage.string(R.string.repo_library_switched))
        val profile = session.cacheScope()
        val revision = cache.catalogRevision
        val page = when (query.kind) {
            "discover" -> coroutineScope {
                val albums = async { api().albums("", limit = 12, sort = "added_at", order = "desc") }
                val added = async { tracks(sort = "added_at", order = "desc", limit = 6) }
                val recent = async { tracks(recent = true, limit = 6) }
                val albumPage = albums.await()
                CatalogPage(albums = albumPage.items, tracks = recent.await().items, addedTracks = added.await().items, total = albumPage.total)
            }
            "albums" -> (if (query.collection == "artists" && query.collectionId != null) api().artistAlbums(url("api", "v1", "artists", query.collectionId, "albums"), query.query, offset = query.offset, role = query.role, sort = query.sort, order = query.order) else api().albums(query.query, offset = query.offset, sort = query.sort, order = query.order)).checked(query).let { CatalogPage(albums = it.items, total = it.total) }
            "artists" -> api().artists(query.query, offset = query.offset, role = query.role).checked(query).let { CatalogPage(artists = it.items, total = it.total) }
            "playlists" -> api().playlists(limit = 50, offset = query.offset).checked(query).let { CatalogPage(playlists = it.items, total = it.total) }
            else -> tracks(query.query, query.offset, query.collection, query.collectionId, query.kind == "recent", query.role, query.sort, albumFilter = query.albumFilter, order = query.order).checked(query).let { CatalogPage(tracks = it.items, total = it.total, discs = it.discs) }
        }
        requireProfile(profile)
        if (query.libraryId != selectedLibraryId) throw CancellationException(AppLanguage.string(R.string.repo_library_switched))
        if (revision != cache.catalogRevision) throw CancellationException(AppLanguage.string(R.string.repo_catalog_updated))
        save("catalog:${query.key}", page, profile, revision)
        (page.tracks + page.addedTracks.orEmpty()).forEach { save("track:${it.id}", it, profile, revision) }
        if (revision != cache.catalogRevision) throw CancellationException(AppLanguage.string(R.string.repo_catalog_updated))
        return page
    }
    suspend fun browseIndex(query: CatalogQuery): BrowseIndex? {
        if (query.libraryId != selectedLibraryId) throw CancellationException(AppLanguage.string(R.string.repo_library_switched))
        if (!query.indexed) return null
        val owner = session.cacheScope()
        val result = api().browseIndex(query.kind, query.query,
            query.collectionId.takeIf { query.collection == "artists" }, query.role.takeIf { query.collection == "artists" || query.kind == "artists" }, query.albumFilter)
        requireProfile(owner)
        if (query.libraryId != selectedLibraryId) throw CancellationException(AppLanguage.string(R.string.repo_library_switched))
        // An older server or incomplete response must not create fabricated positions.
        require(result.kind == query.kind && result.total >= 0 && result.groups.size == 28)
        require(result.groups.map { it.key } == listOf("0–9") + ('A'..'Z').map { it.toString() } + "#")
        require(result.groups.all { it.count >= 0 && (it.offset == null || it.offset in 0 until result.total) })
        return result
    }
    /** Build the complete snapshot before touching playback. Any failed page preserves the old queue. */
    suspend fun collectionTracks(query: CatalogQuery): List<Track> {
        val owner = session.cacheScope() ?: throw IOException(AppLanguage.string(R.string.repo_login_expired))
        val library = selectedLibraryId
        val revision = cache.catalogRevision
        val result = linkedMapOf<String, Track>()
        var offset = 0
        var expected = -1
        while (true) {
            val page = tracks(query.query, offset, query.collection, query.collectionId, query.kind == "recent", query.role, query.sort, 200, query.albumFilter, query.order)
            requireProfile(owner)
            if (library != selectedLibraryId || revision != cache.catalogRevision) throw CancellationException(AppLanguage.string(R.string.repo_library_or_permission_changed))
            if (expected == -1) { expected = page.total; require(expected <= 5000) { AppLanguage.string(R.string.repo_collection_limit_exceeded) } }
            require(expected == page.total) { AppLanguage.string(R.string.repo_collection_changed) }
            if (page.items.isEmpty()) { require(offset >= expected) { AppLanguage.string(R.string.repo_collection_incomplete) }; break }
            page.items.forEach { result[it.id] = it }
            offset += page.items.size
            if (offset >= expected) break
        }
        require(result.size == expected) { AppLanguage.string(R.string.repo_collection_changed) }
        return result.values.toList()
    }
    suspend fun cachedTrack(id: String): Track? = saved("track:$id", Track::class.java)?.let { rememberTrack(it) }
    suspend fun track(id: String): Track {
        val profile = session.cacheScope()
        val snapshot = favoriteClock.get()
        podcastEpisodeId(id)?.let { episodeId ->
            return try {
                val episode = podcastEpisode(episodeId)
                val podcast = podcasts().firstOrNull { it.id == episode.podcastId } ?: throw IOException(AppLanguage.string(R.string.repo_podcast_removed))
                requireProfile(profile)
                rememberPodcastEpisode(episode, podcast)
            } catch (error: IOException) {
                if (error is javax.net.ssl.SSLException || profile != session.cacheScope()) throw error
                cachedTrack(id) ?: throw error
            }
        }
        return try { api().track(url("api", "v1", "tracks", id)).let { requireProfile(profile); val merged = rememberTrack(it, snapshot); downloads.refreshTrack(merged); save("track:$id", merged, profile); requireProfile(profile); rememberTrack(merged, snapshot) } }
        catch (error: HttpException) { if (profile == session.cacheScope() && error.code() in listOf(401, 403, 404)) downloads.remove(id); throw error }
        catch (error: IOException) {
            if (error is javax.net.ssl.SSLException || session.cacheScope() != profile) throw error
            (downloads.track(id) ?: saved("track:$id", Track::class.java) ?: throw error).let { requireProfile(profile); rememberTrack(it) }
        }
    }
    suspend fun cachedLyrics(id: String): Lyrics? = saved("lyrics:$id", Lyrics::class.java)
    suspend fun lyrics(id: String): Lyrics {
        val profile = session.cacheScope()
        return api().lyrics(url("api", "v1", "tracks", id, "lyrics")).also { requireProfile(profile); save("lyrics:$id", it, profile); requireProfile(profile) }
    }
    suspend fun favorite(track: Track): Track {
        val profile = session.cacheScope()
        favoriteChanged(track.id)
        api().favorite(url("api", "v1", "tracks", track.id, "favorite"), FavoriteRequest(!track.loved)).close()
        requireProfile(profile)
        val updated = publishFavorite(track.copy(loved = !track.loved))
        save("track:${updated.id}", updated, profile)
        requireProfile(profile)
        return publishFavorite(updated)
    }
    suspend fun feedback(body: RecommendationFeedback): okhttp3.ResponseBody {
        val profile = session.cacheScope()
        return api().recommendationFeedback(body, RequestOwner(profile)).also { response ->
            if (profile == null || profile != session.cacheScope()) { response.close(); throw CancellationException(AppLanguage.string(R.string.repo_session_changed)) }
        }
    }
    suspend fun logout() {
        val routes = session.routeRecords().mapNotNull { route ->
            val base = ServerAddress.normalize(route.url, route.allowHttp)
            val cookie = session.routeCookie(route.url)?.let { okhttp3.Cookie.parse(base, it) }
                ?.takeIf { it.matches(base) } ?: return@mapNotNull null
            base.resolve("api/v1/auth/logout")!! to "${cookie.name}=${cookie.value}"
        }
        client.dispatcher.cancelAll()
        cache.clear(); session.clearRouteSessions(); session.invalidate(); knownTracks.clear(); database.queue().clear()
        settings.bindAccount(session.activeServerId, session.account?.id)
        withContext(Dispatchers.IO) {
            val isolated = client.newBuilder().apply { interceptors().clear(); networkInterceptors().clear() }
                .cookieJar(CookieJar.NO_COOKIES).retryOnConnectionFailure(false).build()
            for ((target, cookie) in routes) {
                try {
                    isolated.newCall(Request.Builder().url(target).header("Cookie", cookie)
                        .header("X-Wildstring-Client", "android").post("".toRequestBody()).build()).execute().close()
                } catch (_: IOException) { /* The local session was already removed; unreachable routes expire server-side. */ }
            }
        }
    }

}
fun friendlyError(error: Throwable): String = (when (error) {
    is AgentApiException -> error.message ?: AppLanguage.string(R.string.repo_operation_incomplete)
    is HttpException -> when (error.code()) {
        400 -> when {
            error.response()?.errorBody()?.string()?.contains("current_password_incorrect") == true -> AppLanguage.string(R.string.repo_current_password_incorrect)
            else -> AppLanguage.string(R.string.repo_access_rejected)
        }
        422 -> when {
            error.response()?.errorBody()?.string()?.contains("remote_url_fake_ip") == true ->
                AppLanguage.string(R.string.repo_fake_ip_dns_hint)
            else -> AppLanguage.string(R.string.repo_invalid_input_server)
        }
        401 -> AppLanguage.string(R.string.repo_login_expired_relogin)
        403 -> if (error.response()?.errorBody()?.string()?.contains("https_required") == true) AppLanguage.string(R.string.repo_https_only) else AppLanguage.string(R.string.repo_server_forbidden)
        404 -> AppLanguage.string(R.string.repo_not_found)
        409 -> AppLanguage.string(R.string.repo_content_changed)
        429 -> AppLanguage.string(R.string.repo_rate_limited)
        503 -> AppLanguage.string(R.string.repo_server_unavailable_init_admin)
        else -> AppLanguage.string(R.string.repo_request_failed_code, error.code())
    }
    is javax.net.ssl.SSLException -> AppLanguage.string(R.string.repo_ssl_failed)
    is IllegalArgumentException -> error.message ?: AppLanguage.string(R.string.repo_invalid_input)
    is IOException -> AppLanguage.string(R.string.repo_connection_failed)
    else -> AppLanguage.string(R.string.repo_operation_incomplete)
}) + (if (error is HttpException) diagnosticId(error.response()?.headers()?.get("X-Wildstring-Trace-Id"))?.let { "\n" + AppLanguage.string(R.string.repo_diagnostic_id, it) }.orEmpty() else "")
