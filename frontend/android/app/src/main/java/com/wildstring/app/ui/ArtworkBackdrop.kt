package com.wildstring.app.ui

import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.*
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.core.graphics.drawable.toBitmap
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.request.ImageRequest
import coil.request.SuccessResult
import com.wildstring.app.data.ArtworkPixels
import com.wildstring.app.data.Track
import kotlinx.coroutines.*

internal data class Atmosphere(val image: ImageBitmap, val tint: Color)

@Composable internal fun artworkAtmosphere(vm: MusicViewModel, track: Track): Atmosphere? {
    val context = LocalContext.current
    val profile by vm.repository.session.profiles.collectAsStateWithLifecycle()
    val atmosphere by produceState<Atmosphere?>(null, track.id, track.hasCover, track.podcast?.coverUrl, profile) {
        value = null
        if (!track.hasCover || profile == null) return@produceState
        try {
            val result = vm.coverLoader(track.id).execute(ImageRequest.Builder(context).data(vm.repository.cover(track.id))
                .memoryCacheKey("$profile:atmosphere:${vm.repository.cover(track.id)}").size(96).allowHardware(false).build())
            if (result is SuccessResult) value = withContext(Dispatchers.Default) {
                val original = (result.drawable as? BitmapDrawable)?.bitmap ?: result.drawable.toBitmap(96, 96)
                val small = Bitmap.createScaledBitmap(original, 64, 64, true)
                val pixels = IntArray(64 * 64)
                small.getPixels(pixels, 0, 64, 0, 0, 64, 64)
                val tint = Color(ArtworkPixels.tint(pixels))
                val blurred = Bitmap.createBitmap(ArtworkPixels.blur(pixels, 64, 64), 64, 64, Bitmap.Config.ARGB_8888)
                Atmosphere(blurred.asImageBitmap(), tint)
            }
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { /* A missing cover never blocks playback or lyrics. */ }
    }
    return atmosphere
}

@Composable internal fun ArtworkBackdrop(vm: MusicViewModel, track: Track, red: Boolean, includeTestTag: Boolean = true) {
    val dark = LocalDarkAppearance.current
    val surface = MaterialTheme.colorScheme.background
    val atmosphere = artworkAtmosphere(vm, track)
    Box(Modifier.fillMaxSize()) {
        if (red) RedClothBackdrop()
        else Box(Modifier.fillMaxSize().background(Brush.radialGradient(listOf(if (dark) Color(0xFF343F31) else Color(0xFFE7EBDD), surface))))
        Crossfade(atmosphere, animationSpec = tween(420), label = "cover-atmosphere") { art ->
            if (art != null) Box(Modifier.fillMaxSize().then(if (includeTestTag) Modifier.testTag("artwork-atmosphere") else Modifier)) {
                Image(art.image, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop,
                    alpha = if (red) .14f else if (dark) .40f else .30f, filterQuality = FilterQuality.Medium)
                Box(Modifier.fillMaxSize().background(Brush.radialGradient(listOf(art.tint.copy(alpha = if (red) .06f else .18f), Color.Transparent))))
                if (!red) Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(surface.copy(alpha = .16f), surface.copy(alpha = if (dark) .84f else .90f)))))
            }
        }
    }
}
