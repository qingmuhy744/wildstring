package com.wildstring.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.google.gson.JsonObject
import com.wildstring.app.data.*

@Composable internal fun CurationDraftPreview(vm: MusicViewModel, draft: JsonObject, onPreviewReady: (Boolean) -> Unit) {
    val before = draft.getAsJsonObject("before") ?: JsonObject()
    val payload = draft.getAsJsonObject("payload") ?: JsonObject()
    if (draft.text("kind") == "cover") {
        var failed by remember(draft.text("id"), draft.number("version")) { mutableStateOf(false) }
        Text("歌曲：${before.text("title")} · 来源：${before.text("provider")}")
        Text("将采用的封面快照", fontWeight = FontWeight.Medium)
        val profile = vm.repository.session.cacheScope()
        AsyncImage(model = ImageRequest.Builder(LocalContext.current)
            .data(vm.repository.url("api", "v1", "agent", "drafts", draft.text("id"), "cover-preview"))
            .memoryCacheKey("$profile:cover-draft:${draft.text("id")}:${draft.number("version")}").build(),
            imageLoader = vm.imageLoader, contentDescription = "草案封面快照", onSuccess = { failed = false; onPreviewReady(true) }, onError = { failed = true; onPreviewReady(false) }, modifier = Modifier.fillMaxWidth().height(200.dp))
        if (failed) Text("封面快照暂时无法显示，请核对图片后再批准。", color = MaterialTheme.colorScheme.error)
        Text("只采用这份草案保存的图片，不修改歌曲标签。版本变化时会拒绝应用。", style = MaterialTheme.typography.bodySmall)
    } else {
        val items = payload.objects("items")
        Text("${items.size} 首歌曲 · 整批应用，任一版本冲突时整批保留原值。")
        val originals = before.objects("items").associateBy { it.text("track_id") }
        items.forEach { item ->
            val original = originals[item.text("track_id")]
            Text(original?.text("title") ?: item.text("track_id"), fontWeight = FontWeight.Medium)
            val changes = item.getAsJsonObject("overrides") ?: JsonObject()
            changes.entrySet().forEach { (field, value) ->
                Text("${fieldName(field)}：${displayValue(original?.getAsJsonObject("effective")?.get(field))} → ${displayValue(value)}", style = MaterialTheme.typography.bodyMedium)
            }
        }
        Text("请核对专辑版本、曲序和署名。确认仅保存到应用数据库。", style = MaterialTheme.typography.bodySmall)
    }
}
