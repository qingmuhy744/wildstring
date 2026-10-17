package com.wildstring.app.data

const val CATALOG_PAGE_SIZE = 50

/** Absolute positions keep lazy-list anchors stable when loading above an alphabet jump. */
data class CatalogWindow(val pages: Map<Int, CatalogPage> = emptyMap()) {
    val total: Int get() = pages.values.firstOrNull()?.total ?: 0
    fun pageAt(index: Int): CatalogPage? = pages[index / CATALOG_PAGE_SIZE * CATALOG_PAGE_SIZE]
    fun trackAt(index: Int): Track? = pageAt(index)?.tracks?.getOrNull(index % CATALOG_PAGE_SIZE)
    fun albumAt(index: Int): Album? = pageAt(index)?.albums?.getOrNull(index % CATALOG_PAGE_SIZE)
    fun artistAt(index: Int): Artist? = pageAt(index)?.artists?.getOrNull(index % CATALOG_PAGE_SIZE)
    fun playlistAt(index: Int): Playlist? = pageAt(index)?.playlists?.getOrNull(index % CATALOG_PAGE_SIZE)
    fun withPage(offset: Int, page: CatalogPage): CatalogWindow {
        require(offset >= 0 && offset % CATALOG_PAGE_SIZE == 0)
        require(pages.isEmpty() || page.total == total) { "集合已变化，请刷新后重试。" }
        val next = pages.toMutableMap().apply { put(offset, page) }
        // Bound metadata memory while allowing any evicted position to be fetched again.
        if (next.size > 24) next.keys.maxByOrNull { kotlin.math.abs(it - offset) }?.let { next.remove(it) }
        return CatalogWindow(next.toMap())
    }
}

val CatalogPage.itemCount: Int get() = maxOf(tracks.size, albums.size, artists.size, playlists.size)
