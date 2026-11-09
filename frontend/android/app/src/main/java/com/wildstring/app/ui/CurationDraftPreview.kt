package com.wildstring.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.google.gson.JsonObject
import com.wildstring.app.R
import com.wildstring.app.data.*

@Composable internal fun CurationDraftPreview(vm: MusicViewModel, draft: JsonObject, onPreviewReady: (Boolean) -> Unit) {
    val before = draft.getAsJsonObject("before") ?: JsonObject()
    val payload = draft.getAsJsonObject("payload") ?: JsonObject()
    if (draft.text("kind") == "cover") {
        var failed by remember(draft.text("id"), draft.number("version")) { mutableStateOf(false) }
        Text(stringResource(R.string.curation_draft_song_source, before.text("title"), before.text("provider")))
        Text(stringResource(R.string.curation_draft_cover_heading), fontWeight = FontWeight.Medium)
        val profile = vm.repository.session.cacheScope()
        AsyncImage(model = ImageRequest.Builder(LocalContext.current)
            .data(vm.repository.url("api", "v1", "agent", "drafts", draft.text("id"), "cover-preview"))
            .memoryCacheKey("$profile:cover-draft:${draft.text("id")}:${draft.number("version")}").build(),
            imageLoader = vm.imageLoader, contentDescription = stringResource(R.string.curation_draft_cover_desc), onSuccess = { failed = false; onPreviewReady(true) }, onError = { failed = true; onPreviewReady(false) }, modifier = Modifier.fillMaxWidth().height(200.dp))
        if (failed) Text(stringResource(R.string.curation_draft_cover_load_error), color = MaterialTheme.colorScheme.error)
        Text(stringResource(R.string.curation_draft_cover_notice), style = MaterialTheme.typography.bodySmall)
    } else {
        if (payload.text("cover_draft_id").isNotBlank()) {
            val cover = draft.deepCopy().apply { addProperty("id", payload.text("cover_draft_id")); addProperty("kind", "cover"); add("payload", payload.getAsJsonObject("cover_snapshot")); add("before", before.getAsJsonObject("cover")) }
            CurationDraftPreview(vm, cover, onPreviewReady)
        }
        val items = payload.objects("items")
        Text(stringResource(R.string.curation_draft_batch_count_notice, items.size))
        val originals = before.objects("items").associateBy { it.text("track_id") }
        items.forEach { item ->
            val original = originals[item.text("track_id")]
            Text(original?.text("title") ?: item.text("track_id"), fontWeight = FontWeight.Medium)
            val changes = item.getAsJsonObject("overrides") ?: JsonObject()
            changes.entrySet().forEach { (field, value) ->
                Text(stringResource(R.string.curation_draft_field_change, fieldName(field), displayValue(original?.getAsJsonObject("effective")?.get(field)), displayValue(value)), style = MaterialTheme.typography.bodyMedium)
            }
        }
        Text(stringResource(R.string.curation_draft_batch_verify_notice), style = MaterialTheme.typography.bodySmall)
    }
}
