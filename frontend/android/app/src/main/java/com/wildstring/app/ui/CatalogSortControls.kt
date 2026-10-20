package com.wildstring.app.ui

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
    val context = catalogSortContext(state.kind, state.collection, state.albumFilter) ?: return
    val choices = catalogSortChoices(context)
    var expanded by remember { mutableStateOf(false) }
    Box(modifier) {
        TextButton({ expanded = true }, Modifier.testTag("catalog-sort").semantics {
            stateDescription = if (state.order == "asc") "升序" else "降序"
        }, contentPadding = PaddingValues(horizontal = 6.dp)) {
            Text(choices.firstOrNull { it.first == state.sort }?.second ?: "歌曲名称", modifier = Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.labelLarge, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
            Icon(Icons.Default.ArrowDropDown, null)
        }
        DropdownMenu(expanded, { expanded = false }) {
            choices.forEach { (key, label) -> DropdownMenuItem(text = { Text(label) }, onClick = { expanded = false; sort(key) },
                trailingIcon = { if (state.sort == key) Icon(Icons.Default.Check, null) }) }
            HorizontalDivider()
            listOf("asc" to "升序", "desc" to "降序").forEach { (key, label) ->
                DropdownMenuItem(text = { Text(label) }, modifier = Modifier.testTag("catalog-sort-order-$key"),
                    leadingIcon = { Icon(if (key == "asc") Icons.Default.ArrowUpward else Icons.Default.ArrowDownward, null) },
                    trailingIcon = { if (state.order == key) Icon(Icons.Default.Check, null) },
                    onClick = { expanded = false; if (state.order != key) reverse() })
            }
        }
    }
}
