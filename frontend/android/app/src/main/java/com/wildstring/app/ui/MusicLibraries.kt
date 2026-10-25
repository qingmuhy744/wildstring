package com.wildstring.app.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable internal fun MusicLibraryChoice(vm: MusicViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    if (!state.librariesSupported) return
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("music-library-choice")) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(state.selectedLibraryId == "all", { vm.selectLibrary("all") }, label = { Text("全部可访问库") })
            state.libraries.forEach { library ->
                FilterChip(state.selectedLibraryId == library.id, { vm.selectLibrary(library.id) }, label = { Text(library.name) })
            }
        }
        if (state.libraries.isEmpty()) Text("尚未分配音乐库，可联系所有者授权。", style = MaterialTheme.typography.bodySmall)
    }
}
