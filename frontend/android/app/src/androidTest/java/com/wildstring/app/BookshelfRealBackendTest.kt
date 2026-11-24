package com.wildstring.app

import android.content.ComponentName
import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.playback.BookPlaybackService
import com.wildstring.app.ui.MusicViewModel
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

class BookshelfRealBackendTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun capture(name: String) {
        compose.waitForIdle()
        val run = InstrumentationRegistry.getInstrumentation()
        val output = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: run.targetContext.getExternalFilesDir(null)!!
        output.mkdirs()
        val image = run.uiAutomation.takeScreenshot()!!
        File(output, name).outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }

    @Test fun opensLibraryAndReadsInBothModes() {
        val endpoint = InstrumentationRegistry.getArguments().getString("realBackend")
        assumeTrue("Disposable synthetic realBackend is required", endpoint != null)
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val connecting = compose.runOnIdle {
            vm.repository.session.invalidate(); vm.sharing.mode("off")
            vm.connect(endpoint!!, "admin", "disposable-browser-test-password", true)
        }
        compose.waitUntil(20_000) { connecting.isCompleted && vm.state.value.connected && !vm.state.value.loading }
        compose.onNodeWithTag("nav-podcast").performClick()
        compose.onNodeWithText(uiString(R.string.books_title)).performClick()
        val book = hasText("Portable Pages", substring = true) and hasClickAction()
        compose.waitUntil(20_000) { compose.onAllNodes(book).fetchSemanticsNodes().isNotEmpty() }
        capture("bookshelf.png")
        compose.onAllNodes(book).onFirst().performClick()
        compose.onNodeWithText(uiString(R.string.books_read)).performClick()
        val chapter = hasText("Chapter 1 — A Window", substring = false)
        compose.waitUntil(15_000) { compose.onAllNodes(chapter).fetchSemanticsNodes().isNotEmpty() }
        val paginated = compose.onAllNodesWithText(uiString(R.string.books_pages))
        if (paginated.fetchSemanticsNodes().isNotEmpty()) paginated.onFirst().performClick()
        compose.onNodeWithText(uiString(R.string.books_scroll)).assertIsDisplayed()
        capture("reader-scroll.png")
        val first = compose.onNodeWithText("Chapter 1 — A Window")
        first.performSemanticsAction(SemanticsActions.SetSelection) { select -> assertTrue(select(0, 7, false)) }
        compose.onNodeWithText(uiString(R.string.books_annotate)).performClick()
        compose.onNodeWithText(uiString(R.string.books_amber)).performClick()
        val bookId = runBlocking { vm.repository.api().books().items.first { it.title == "Portable Pages" }.id }
        compose.waitUntil(10_000) {
            runBlocking { vm.repository.api().bookAnnotations(bookId).items }.any {
                it.startBlock == 0 && it.startOffset == 0 && it.endOffset == 7 && it.color == "amber"
            }
        }
        compose.onNodeWithText(uiString(R.string.books_scroll)).performClick()
        compose.onNodeWithText(uiString(R.string.books_pages)).assertIsDisplayed()
        capture("reader-pages.png")
        compose.runOnIdle { vm.repository.session.invalidate() }
    }

    @Test fun audiobookSessionSurvivesLeavingTheBookshelf() {
        val endpoint = InstrumentationRegistry.getArguments().getString("realBackend")
        assumeTrue("Disposable synthetic realBackend is required", endpoint != null)
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val connecting = compose.runOnIdle {
            vm.repository.session.invalidate(); vm.sharing.mode("off")
            vm.connect(endpoint!!, "admin", "disposable-browser-test-password", true)
        }
        compose.waitUntil(20_000) { connecting.isCompleted && vm.state.value.connected && !vm.state.value.loading }
        compose.onNodeWithTag("nav-podcast").performClick()
        compose.onNodeWithText(uiString(R.string.books_title)).performClick()
        val audio = hasText(uiString(R.string.books_audiobook), substring = true) and hasClickAction()
        compose.waitUntil(20_000) { compose.onAllNodes(audio).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(audio).onFirst().performClick()
        compose.onNodeWithText(uiString(R.string.books_listen)).performClick()
        val play = hasText(uiString(R.string.books_play), substring = false) and hasClickAction()
        compose.waitUntil(15_000) { compose.onAllNodes(play).fetchSemanticsNodes().isNotEmpty() }
        val token = SessionToken(compose.activity, ComponentName(compose.activity, BookPlaybackService::class.java))
        val connection = MediaController.Builder(compose.activity, token).buildAsync()
        val controller = connection.get(10, TimeUnit.SECONDS)
        try {
            compose.onNode(play).performClick()
            try {
                compose.waitUntil(12_000) { compose.runOnIdle { controller.isPlaying } }
            } catch (cause: ComposeTimeoutException) {
                val state = compose.runOnIdle {
                    "items=${controller.mediaItemCount}, state=${controller.playbackState}, " +
                        "playWhenReady=${controller.playWhenReady}, error=${controller.playerError?.errorCodeName}"
                }
                throw AssertionError("Audiobook failed to start ($state)", cause)
            }
            compose.onNodeWithText(uiString(R.string.books_back)).performClick()
            assertTrue(compose.runOnIdle { controller.isPlaying })
            assertTrue(compose.runOnIdle { controller.currentMediaItem?.mediaId?.startsWith("book:") == true })
        } finally {
            compose.runOnIdle { controller.pause(); controller.release(); vm.repository.session.invalidate() }
        }
    }

}
