package com.wildstring.app.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.wildstring.app.data.PodcastSummary

@Composable
internal fun PodcastArtworkImage(vm: MusicViewModel, podcast: PodcastSummary, modifier: Modifier) {
    val artwork = vm.repository.podcastArtwork(podcast.id)
    val profile = vm.repository.session.cacheScope()
    var loaded by remember(artwork, profile) { mutableStateOf(false) }
    Box(modifier, contentAlignment = Alignment.Center) {
        if (!loaded) Icon(Icons.Default.Podcasts, null, Modifier.size(32.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        AsyncImage(
            model = ImageRequest.Builder(LocalContext.current)
                .data(artwork)
                .memoryCacheKey("$profile:podcast:${podcast.id}:${podcast.coverUrl}")
                .crossfade(true).build(),
            imageLoader = vm.imageLoader,
            contentDescription = podcast.title,
            contentScale = ContentScale.Crop,
            onLoading = { loaded = false },
            onSuccess = { loaded = true },
            onError = { loaded = false },
            modifier = Modifier.fillMaxSize(),
        )
    }
}
