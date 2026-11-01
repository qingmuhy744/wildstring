package com.wildstring.app.ui

import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wildstring.app.data.*

@Composable internal fun CatalogSortControls(state: MusicState, sort: (String) -> Unit, reverse: () -> Unit, modifier: Modifier = Modifier) {
    val resources = androidx.compose.ui.platform.LocalResources.current
    val context = catalogSortContext(state.kind, state.collection, state.albumFilter) ?: return
    val choices = catalogSortChoices(context)
    var expanded by remember { mutableStateOf(false) }
    Box(modifier) {
        TextButton({ expanded = true }, Modifier.testTag("catalog-sort").semantics {
            stateDescription = if (state.order == "asc") resources.getString(R.string.sort_ascending) else resources.getString(R.string.sort_descending)
        }, contentPadding = PaddingValues(horizontal = 6.dp)) {
            Text(stringResource(catalogSortLabel(state.sort, context)), modifier = Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.labelLarge, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
            Icon(Icons.Default.ArrowDropDown, null)
        }
        DropdownMenu(expanded, { expanded = false }) {
            choices.forEach { (key, _) -> DropdownMenuItem(text = { Text(stringResource(catalogSortLabel(key, context))) }, onClick = { expanded = false; sort(key) },
                trailingIcon = { if (state.sort == key) Icon(Icons.Default.Check, null) }) }
            HorizontalDivider()
            listOf("asc" to resources.getString(R.string.sort_ascending), "desc" to resources.getString(R.string.sort_descending)).forEach { (key, label) ->
                DropdownMenuItem(text = { Text(label) }, modifier = Modifier.testTag("catalog-sort-order-$key"),
                    leadingIcon = { Icon(if (key == "asc") Icons.Default.ArrowUpward else Icons.Default.ArrowDownward, null) },
                    trailingIcon = { if (state.order == key) Icon(Icons.Default.Check, null) },
                    onClick = { expanded = false; if (state.order != key) reverse() })
            }
        }
    }
}

@androidx.annotation.StringRes internal fun catalogSortLabel(key: String, context: String): Int = when (key) {
    "added_at" -> R.string.sort_added
    "release_date" -> R.string.sort_release
    "artist" -> R.string.sort_artist
    "track_number" -> R.string.sort_disc_track
    "duration_ms" -> R.string.sort_duration
    "play_count" -> R.string.sort_plays
    "listened_ms" -> R.string.sort_listening_time
    "last_played_at" -> R.string.recently_played
    else -> if (context.endsWith("albums")) R.string.sort_album_name else R.string.sort_track_name
}
