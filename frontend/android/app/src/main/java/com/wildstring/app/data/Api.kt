package com.wildstring.app.data

import okhttp3.ResponseBody
import com.google.gson.JsonObject
import retrofit2.http.*

interface Api {
    @POST suspend fun uploadAvatar(@Url url: String, @Body body: okhttp3.RequestBody, @Tag owner: RequestOwner): retrofit2.Response<JsonObject>
    @GET suspend fun agentGet(@Url url: String, @Tag owner: RequestOwner? = null): retrofit2.Response<JsonObject>
    @POST suspend fun agentPost(@Url url: String, @Body body: JsonObject, @Tag policy: AgentRequestPolicy? = null, @Tag owner: RequestOwner? = null): retrofit2.Response<JsonObject>
    @PATCH suspend fun agentPatch(@Url url: String, @Body body: JsonObject): retrofit2.Response<JsonObject>
    @PUT suspend fun agentPut(@Url url: String, @Body body: JsonObject, @Tag owner: RequestOwner? = null): retrofit2.Response<JsonObject>
    @DELETE suspend fun agentDelete(@Url url: String, @Tag owner: RequestOwner? = null): retrofit2.Response<JsonObject>
    @GET suspend fun objectGet(@Url url: String): JsonObject
    @POST suspend fun objectPost(@Url url: String, @Body body: JsonObject): JsonObject
    @PUT suspend fun objectPut(@Url url: String, @Body body: JsonObject): JsonObject
    @POST suspend fun uploadPlugin(@Url url: String, @Body body: okhttp3.RequestBody, @Tag owner: RequestOwner? = null): retrofit2.Response<JsonObject>
    @Streaming @GET suspend fun downloadPlugin(@Url url: String, @Tag owner: RequestOwner? = null): ResponseBody
    @Streaming @GET suspend fun coverImage(@Url url: String, @Tag owner: RequestOwner): ResponseBody
    @GET suspend fun playlist(@Url url: String): Playlist
    @PUT suspend fun updatePlaylist(@Url url: String, @Body body: PlaylistUpdate): Playlist
    @DELETE suspend fun deletePlaylist(@Url url: String, @Query("version") version: Int): retrofit2.Response<Unit>
    @PUT suspend fun reorderPlaylist(@Url url: String, @Body body: AddTracks): Playlist
    @GET("api/v1/listening/summary") suspend fun listeningSummary(): ListeningSummary
    @GET("api/v1/playback/state") suspend fun sharedPlayback(@Tag owner: RequestOwner? = null): SharedPlayback
    @PUT("api/v1/playback/state") suspend fun saveSharedPlayback(@Body body: SharedPlaybackWrite, @Tag owner: RequestOwner? = null): SharedPlayback
    @GET("api/v1/recommendations/daily") suspend fun daily(@Tag policy: AgentRequestPolicy? = AgentRequestPolicy()): DailyRecommendations
    @POST("api/v1/recommendations/daily/refresh") suspend fun refreshDaily(@Body body: JsonObject = JsonObject(), @Tag policy: AgentRequestPolicy? = AgentRequestPolicy()): DailyRecommendations
    @GET("api/v1/recommendations/preferences") suspend fun recommendationPreferences(): RecommendationPreferences
    @PUT("api/v1/recommendations/preferences") suspend fun saveRecommendationPreferences(@Body body: RecommendationPreferences): RecommendationPreferences
    @POST("api/v1/recommendations/feedback") suspend fun recommendationFeedback(@Body body: RecommendationFeedback, @Tag owner: RequestOwner? = null): ResponseBody
    @GET("api/v1/recommendations/external") suspend fun externalMusic(@Tag policy: AgentRequestPolicy? = AgentRequestPolicy()): ExternalMusicResult
    @POST("api/v1/recommendations/external/refresh") suspend fun refreshExternalMusic(@Body body: JsonObject = JsonObject(), @Tag policy: AgentRequestPolicy? = AgentRequestPolicy()): ExternalMusicResult
    @POST("api/v1/recommendations/external/feedback") suspend fun externalMusicFeedback(@Body body: ExternalMusicFeedback): JsonObject
    @GET("api/v1/recommendations/rankings") suspend fun listeningRankings(@Query("scope") scope: String = "personal",
        @Query("period") period: String = "30d", @Query("metric") metric: String = "plays", @Query("limit") limit: Int = 20,
        @Query("offset") offset: Int = 0): ListeningRankings
    @POST("api/v1/ai/discover") suspend fun discover(@Body body: DiscoveryRequest, @Tag policy: AgentRequestPolicy? = AgentRequestPolicy()): DiscoveryResult
    @GET("api/v1/lastfm") suspend fun lastfm(): LastfmStatus
    @POST("api/v1/lastfm/authorize") suspend fun authorizeLastfm(): AuthorizationUrl
    @PUT("api/v1/lastfm") suspend fun updateLastfm(@Body body: LastfmPreferences): LastfmStatus
    @DELETE("api/v1/lastfm") suspend fun disconnectLastfm(): retrofit2.Response<Unit>
    @GET("api/v1/auth/status") suspend fun status(): AuthStatus
    @POST("api/v1/auth/login") suspend fun login(@Body body: LoginRequest): ResponseBody
    @POST("api/v1/auth/logout") suspend fun logout(): retrofit2.Response<Unit>
    @POST("api/v1/auth/password") suspend fun changePassword(@Header("Cookie") cookie: String, @Body body: PasswordChange): retrofit2.Response<Unit>
    @GET suspend fun tracks(@Url url: String, @Query("q") query: String, @Query("limit") limit: Int = 50, @Query("offset") offset: Int = 0): Page<Track>
    @GET suspend fun track(@Url url: String): Track
    @GET("api/v1/albums") suspend fun albums(@Query("q") query: String, @Query("limit") limit: Int = 50, @Query("offset") offset: Int = 0): Page<Album>
    @GET suspend fun artistAlbums(@Url url: String, @Query("q") query: String, @Query("limit") limit: Int = 50, @Query("offset") offset: Int = 0, @Query("role") role: String = "artist"): Page<Album>
    @GET("api/v1/artists") suspend fun artists(@Query("q") query: String, @Query("limit") limit: Int = 50, @Query("offset") offset: Int = 0, @Query("role") role: String = "artist"): Page<Artist>
    @GET("api/v1/browse-index") suspend fun browseIndex(@Query("kind") kind: String, @Query("q") query: String,
        @Query("artist_id") artistId: String? = null, @Query("role") role: String? = null,
        @Query("album_id") albumId: String? = null): BrowseIndex
    @GET("api/v1/playlists") suspend fun playlists(@Query("limit") limit: Int = 100, @Query("offset") offset: Int = 0): Page<Playlist>
    @GET suspend fun lyrics(@Url url: String): Lyrics
    @PUT suspend fun favorite(@Url url: String, @Body body: FavoriteRequest): ResponseBody
    @POST("api/v1/playlists") suspend fun createPlaylist(@Body body: PlaylistRequest): Playlist
    @PUT suspend fun renamePlaylist(@Url url: String, @Body body: RenamePlaylist): Playlist
    @POST suspend fun addTracks(@Url url: String, @Body body: AddTracks): Playlist
    @DELETE suspend fun removeTrack(@Url url: String, @Query("version") version: Int): ResponseBody
    @POST("api/v1/listening") suspend fun listening(@Body body: ListeningRequest, @Tag owner: RequestOwner? = null): ResponseBody
}
