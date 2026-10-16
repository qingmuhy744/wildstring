package com.wildstring.app.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

@Composable internal fun FavoriteControl(loved: Boolean, pending: Boolean, click: () -> Unit) {
    val color by animateColorAsState(if (loved) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, label = "favorite-color")
    val scale by animateFloatAsState(if (loved) 1.12f else 1f, label = "favorite-scale")
    Box(contentAlignment = Alignment.Center) {
        IconButton(click, enabled = !pending, modifier = Modifier.semantics { stateDescription = if (pending) "正在保存" else if (loved) "已收藏" else "未收藏" }) {
            Icon(if (loved) Icons.Default.Favorite else Icons.Default.FavoriteBorder, if (loved) "取消收藏" else "收藏",
                Modifier.graphicsLayer { scaleX = scale; scaleY = scale }, tint = color)
        }
        if (pending) CircularProgressIndicator(Modifier.size(38.dp), strokeWidth = 1.dp, color = color.copy(alpha = .4f))
    }
}
