package com.wildstring.app.data

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
    if (context.endsWith("albums")) return listOf("title" to "专辑名称", "added_at" to "入库时间", "release_date" to "发行时间", "artist" to "艺人名称")
    return (if (context == "album-tracks") listOf("track_number" to "碟号与曲序", "name" to "歌曲名称") else listOf("title" to "歌曲名称")) +
        listOf("added_at" to "入库时间", "duration_ms" to "歌曲时长", "play_count" to "播放次数", "listened_ms" to "收听时长", "last_played_at" to "最近听过")
}
