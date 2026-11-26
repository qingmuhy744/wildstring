package com.wildstring.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonColors
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wildstring.app.R

@Composable
internal fun PlaybackSkipButton(
    rewind: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    arrowSize: Dp = 18.dp,
    colors: IconButtonColors = IconButtonDefaults.iconButtonColors(),
) {
    val label = stringResource(if (rewind) R.string.pod_player_rewind_15 else R.string.pod_player_forward_30)
    IconButton(onClick, modifier.size(48.dp), enabled = enabled, colors = colors) {
        Row(
            modifier = Modifier.clearAndSetSemantics { contentDescription = label },
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Replay, null, Modifier.size(arrowSize).scale(if (rewind) 1f else -1f, 1f))
            Text(
                if (rewind) "15" else "30",
                style = MaterialTheme.typography.labelSmall.copy(
                    fontFamily = FontFamily.Monospace,
                    fontFeatureSettings = "tnum",
                    letterSpacing = 0.sp,
                ),
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}
