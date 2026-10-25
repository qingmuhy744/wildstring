package com.wildstring.app.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.text.style.URLSpan
import android.view.View
import android.widget.TextView
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.text.HtmlCompat
import com.wildstring.app.data.podcastArtworkUrl
import com.wildstring.app.data.podcastTimestamps

/** RSS is untrusted content. Render text formatting only; never execute a page or load its images. */
internal fun podcastArticleText(raw: String, durationMs: Long, onSeek: ((Long) -> Unit)?): CharSequence {
    val source = raw.replace(Regex("<(script|style)\\b[^>]*>[\\s\\S]*?</\\1\\s*>", RegexOption.IGNORE_CASE), "")
    val rich = Regex("</?[a-z][^>]*>", RegexOption.IGNORE_CASE).containsMatchIn(source)
    val text = SpannableStringBuilder(if (rich) HtmlCompat.fromHtml(source, HtmlCompat.FROM_HTML_MODE_COMPACT) else source)
    val links = text.getSpans(0, text.length, URLSpan::class.java).map { span ->
        Triple(text.getSpanStart(span), text.getSpanEnd(span), span.url).also { text.removeSpan(span) }
    }
    links.forEach { (start, end, url) ->
        if (podcastArtworkUrl(url) != null) text.setSpan(object : ClickableSpan() {
            override fun onClick(widget: View) {
                try {
                    widget.context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (_: ActivityNotFoundException) { /* The device has no browser. */ }
            }
        }, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    if (onSeek != null) podcastTimestamps(text, durationMs).forEach { timestamp ->
        // A timestamp-only hyperlink is a chapter. Keep other links (including URLs with ports) intact.
        val overlap = links.filter { it.first < timestamp.end && it.second > timestamp.start }
        if (overlap.any { text.subSequence(it.first, it.second).toString().trim().trim('[', ']') != text.subSequence(timestamp.start, timestamp.end).toString() }) return@forEach
        text.getSpans(timestamp.start, timestamp.end, ClickableSpan::class.java).forEach(text::removeSpan)
        text.setSpan(object : ClickableSpan() {
            override fun onClick(widget: View) = onSeek(timestamp.positionMs)
        }, timestamp.start, timestamp.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    return text
}

@Composable
internal fun PodcastArticleText(raw: String, modifier: Modifier = Modifier, durationMs: Long = 0, onSeek: ((Long) -> Unit)? = null) {
    val latestSeek = rememberUpdatedState(onSeek)
    val text = remember(raw, durationMs, onSeek != null) {
        podcastArticleText(raw, durationMs, if (onSeek == null) null else { time -> latestSeek.value?.invoke(time) })
    }
    val foreground = MaterialTheme.colorScheme.onSurface.toArgb()
    val link = MaterialTheme.colorScheme.primary.toArgb()
    AndroidView(modifier = modifier, factory = { context ->
        TextView(context).apply {
            textSize = 17f
            typeface = Typeface.create("serif", Typeface.NORMAL)
            setLineSpacing(0f, 1.4f)
            setPadding(0, 0, 0, 0)
            setTextIsSelectable(true)
            movementMethod = LinkMovementMethod.getInstance()
            linksClickable = true
        }
    }, update = { view ->
        if (view.tag !== text) { view.text = text; view.tag = text }
        view.setTextColor(foreground)
        view.setLinkTextColor(link)
    })
}
