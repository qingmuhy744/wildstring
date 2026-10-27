package com.wildstring.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable internal fun MusicLibraryChoice(vm: MusicViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    if (!state.librariesSupported || state.libraries.size == 1) return
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("music-library-choice")) {
        if (state.libraries.isEmpty()) {
            Text("暂无可播放的音乐，可联系管理员分配访问权限。", style = MaterialTheme.typography.bodySmall)
        } else Box {
            TextButton(onClick = { expanded = true }) {
                Text((state.libraries.find { it.id == state.selectedLibraryId }?.name ?: "全部音乐") + " ▾")
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                DropdownMenuItem(text = { Text("全部音乐") }, onClick = { expanded = false; vm.selectLibrary("all") })
                state.libraries.forEach { library ->
                    DropdownMenuItem(text = { Text(library.name) }, onClick = { expanded = false; vm.selectLibrary(library.id) })
                }
            }
        }
    }
}
