package com.wildstring.app

import android.text.Spanned
import android.text.style.ClickableSpan
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.ui.podcastArticleText
import org.junit.Assert.*
import org.junit.Test

class PodcastArticleTest {
    @Test fun formattedArticleKeepsParagraphsAndTimestampLinksSeekPrecisely() {
        var position = -1L
        val article = podcastArticleText("<p>本期介绍</p><p><b>主要话题</b></p><p>[01:03:36] 再次创业</p>", 7200_000) { position = it } as Spanned
        assertTrue(article.toString().contains("本期介绍\n"))
        val span = article.getSpans(0, article.length, ClickableSpan::class.java).single()
        assertEquals("01:03:36", article.subSequence(article.getSpanStart(span), article.getSpanEnd(span)).toString())
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            span.onClick(TextView(InstrumentationRegistry.getInstrumentation().targetContext))
        }
        assertEquals(3816_000L, position)
    }

    @Test fun timestampsInsideReferenceLinksDoNotHijackTheirDestinations() {
        val article = podcastArticleText("<p><a href='https://example.com/article'>[47:19] 延伸阅读</a></p><a href='https://example.com/chapter'>03:52</a>", 7200_000) {} as Spanned
        val labels = article.getSpans(0, article.length, ClickableSpan::class.java).map { article.subSequence(article.getSpanStart(it), article.getSpanEnd(it)).toString() }
        assertEquals(listOf("[47:19] 延伸阅读", "03:52"), labels)
    }

    @Test fun unsafeLinksAndScriptsAreNotInteractive() {
        val article = podcastArticleText("<script>alert('hidden')</script><a href='javascript:alert(1)'>unsafe</a><a href='https://example.com'>source</a>", 0, null) as Spanned
        assertFalse(article.toString().contains("hidden"))
        val links = article.getSpans(0, article.length, ClickableSpan::class.java)
        assertEquals(1, links.size)
        assertEquals("source", article.subSequence(article.getSpanStart(links[0]), article.getSpanEnd(links[0])).toString())
    }
}
