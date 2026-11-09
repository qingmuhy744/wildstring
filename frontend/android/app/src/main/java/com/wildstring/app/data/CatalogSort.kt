package com.wildstring.app.data

import com.wildstring.app.AppLanguage
import com.wildstring.app.R

data class CatalogSort(val sort: String, val order: String)
fun catalogSortContext(kind: String, collection: String?, albumFilter: String?): String? = when {
    collection == "playlists" -> null
    kind == "albums" -> if (collection == "artists") "artist-albums" else "albums"
    kind == "recent" -> "recent"
    kind != "tracks" -> null
    collection == "albums" || albumFilter != null -> "album-tracks"
    collection == "artists" -> "artist-tracks"
    else -> "tracks"
}
fun defaultCatalogSort(context: String) = when (context) {
    "album-tracks" -> CatalogSort("track_number", "asc")
    "recent" -> CatalogSort("last_played_at", "desc")
    else -> CatalogSort("title", "asc")
}
fun catalogSortChoices(context: String): List<Pair<String, String>> {
    if (context.endsWith("albums")) return listOf(
        "title" to AppLanguage.string(R.string.cat_sort_album_title),
        "added_at" to AppLanguage.string(R.string.cat_sort_added_at),
        "release_date" to AppLanguage.string(R.string.cat_sort_release_date),
        "artist" to AppLanguage.string(R.string.cat_sort_artist_name)
    )
    return (if (context == "album-tracks") listOf(
        "track_number" to AppLanguage.string(R.string.cat_sort_disc_and_track),
        "name" to AppLanguage.string(R.string.cat_sort_track_title)
    ) else listOf("title" to AppLanguage.string(R.string.cat_sort_track_title))) +
        listOf(
            "added_at" to AppLanguage.string(R.string.cat_sort_added_at),
            "duration_ms" to AppLanguage.string(R.string.cat_sort_duration),
            "play_count" to AppLanguage.string(R.string.cat_sort_play_count),
            "listened_ms" to AppLanguage.string(R.string.cat_sort_listened_time),
            "last_played_at" to AppLanguage.string(R.string.cat_sort_last_played)
        )
}
