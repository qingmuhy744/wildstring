package dev.wildstring.app.data

import okhttp3.ResponseBody
import retrofit2.http.*

interface Api {
    @GET("api/v1/auth/status") suspend fun status(): AuthStatus
    @POST("api/v1/auth/login") suspend fun login(@Body body: LoginRequest): ResponseBody
    @POST("api/v1/auth/logout") suspend fun logout(): retrofit2.Response<Unit>
    @GET suspend fun tracks(@Url url: String, @Query("q") query: String, @Query("limit") limit: Int = 50, @Query("offset") offset: Int = 0): Page<Track>
    @GET suspend fun track(@Url url: String): Track
    @GET("api/v1/albums") suspend fun albums(@Query("q") query: String, @Query("limit") limit: Int = 50, @Query("offset") offset: Int = 0): Page<Album>
    @GET("api/v1/artists") suspend fun artists(@Query("q") query: String, @Query("limit") limit: Int = 50, @Query("offset") offset: Int = 0): Page<Artist>
    @GET("api/v1/playlists") suspend fun playlists(@Query("limit") limit: Int = 100, @Query("offset") offset: Int = 0): Page<Playlist>
    @GET suspend fun lyrics(@Url url: String): Lyrics
    @PUT suspend fun favorite(@Url url: String, @Body body: FavoriteRequest): ResponseBody
    @POST("api/v1/playlists") suspend fun createPlaylist(@Body body: PlaylistRequest): Playlist
    @PUT suspend fun renamePlaylist(@Url url: String, @Body body: RenamePlaylist): Playlist
    @POST suspend fun addTracks(@Url url: String, @Body body: AddTracks): Playlist
    @DELETE suspend fun removeTrack(@Url url: String, @Query("version") version: Int): ResponseBody
    @POST("api/v1/listening") suspend fun listening(@Body body: ListeningRequest): ResponseBody
}
