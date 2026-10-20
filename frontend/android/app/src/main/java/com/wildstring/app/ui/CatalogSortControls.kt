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
import androidx.compose.ui.unit.dp
import com.wildstring.app.data.*

@Composable internal fun CatalogSortControls(state: MusicState, sort: (String) -> Unit, reverse: () -> Unit) {
    val context = catalogSortContext(state.kind, state.collection, state.albumFilter) ?: return
    val choices = catalogSortChoices(context)
    var expanded by remember { mutableStateOf(false) }
    Row {
        Box {
            TextButton({ expanded = true }, Modifier.testTag("catalog-sort"), contentPadding = PaddingValues(horizontal = 6.dp)) {
                Text(choices.firstOrNull { it.first == state.sort }?.second ?: "歌曲名称", style = MaterialTheme.typography.labelLarge)
                Icon(Icons.Default.ArrowDropDown, null)
            }
            DropdownMenu(expanded, { expanded = false }) {
                choices.forEach { (key, label) -> DropdownMenuItem(text = { Text(label) }, onClick = { expanded = false; sort(key) },
                    trailingIcon = { if (state.sort == key) Icon(Icons.Default.Check, null) }) }
            }
        }
        IconButton(reverse, Modifier.testTag("catalog-sort-order")) {
            Icon(if (state.order == "asc") Icons.Default.ArrowUpward else Icons.Default.ArrowDownward,
                if (state.order == "asc") "切换为降序" else "切换为升序")
        }
    }
}
