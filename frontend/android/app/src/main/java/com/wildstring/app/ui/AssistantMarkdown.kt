package com.wildstring.app.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.commonmark.parser.Parser
import org.commonmark.node.*
import org.commonmark.node.Text as MarkdownText
import org.commonmark.node.Paragraph as MarkdownParagraph
import org.commonmark.ext.gfm.tables.*

private val markdownParser = Parser.builder().extensions(listOf(TablesExtension.create())).build()
private fun children(node: Node): Sequence<Node> = generateSequence(node.firstChild) { it.next }
internal fun safeAssistantLink(url: String): Boolean = runCatching {
    val uri = java.net.URI(url)
    uri.scheme?.lowercase() in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.userInfo == null
}.getOrDefault(false)

private fun AnnotatedString.Builder.inline(node: Node, linkColor: Color) {
    when (node) {
        is MarkdownText -> append(node.literal)
        is SoftLineBreak -> append(" ")
        is HardLineBreak -> append("\n")
        is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(node.literal) }
        is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { children(node).forEach { inline(it, linkColor) } }
        is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { children(node).forEach { inline(it, linkColor) } }
        is Link -> if (safeAssistantLink(node.destination)) {
            withLink(LinkAnnotation.Url(node.destination, TextLinkStyles(style = SpanStyle(color = linkColor)))) { children(node).forEach { inline(it, linkColor) } }
        } else children(node).forEach { inline(it, linkColor) }
        is HtmlInline -> Unit
        else -> children(node).forEach { inline(it, linkColor) }
    }
}

@Composable internal fun AssistantMarkdown(content: String) {
    val document = remember(content) { markdownParser.parse(content) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        children(document).forEach { MarkdownBlock(it) }
    }
}

@Composable private fun MarkdownBlock(node: Node) {
    val color = MaterialTheme.colorScheme.primary
    when (node) {
        is MarkdownParagraph, is Heading -> {
            val text = buildAnnotatedString { children(node).forEach { inline(it, color) } }
            Text(text, Modifier.fillMaxWidth(), style = if (node is Heading) MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold) else MaterialTheme.typography.bodyLarge)
        }
        is BulletList, is OrderedList -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            children(node).forEachIndexed { index, item ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(if (node is OrderedList) "${node.markerStartNumber + index}." else "•", style = MaterialTheme.typography.bodyLarge)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) { children(item).forEach { MarkdownBlock(it) } }
                }
            }
        }
        is BlockQuote -> Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.small) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { children(node).forEach { MarkdownBlock(it) } }
        }
        is FencedCodeBlock, is IndentedCodeBlock -> {
            val text = if (node is FencedCodeBlock) node.literal else (node as IndentedCodeBlock).literal
            Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.small) {
                Text(text.trimEnd(), Modifier.horizontalScroll(rememberScrollState()).padding(12.dp), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        }
        is ThematicBreak -> HorizontalDivider()
        is TableBlock -> Column(Modifier.horizontalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            children(node).forEach { section -> children(section).forEach { row ->
                Row { children(row).forEach { cell ->
                    Text(buildAnnotatedString { children(cell).forEach { inline(it, color) } }, Modifier.width(168.dp).padding(8.dp), style = MaterialTheme.typography.bodyMedium, fontWeight = if ((cell as? TableCell)?.isHeader == true) FontWeight.SemiBold else FontWeight.Normal)
                } }
                HorizontalDivider()
            } }
        }
        is HtmlBlock -> Unit
        else -> children(node).forEach { MarkdownBlock(it) }
    }
}
