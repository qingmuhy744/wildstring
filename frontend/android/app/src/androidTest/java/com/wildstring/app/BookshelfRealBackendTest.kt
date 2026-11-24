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
import com.google.gson.JsonObject
import com.wildstring.app.data.RequestOwner
import com.wildstring.app.playback.BookPlaybackService
import com.wildstring.app.ui.MusicViewModel
import java.io.File
import java.util.UUID
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
        val bookId = runBlocking {
            val api = vm.repository.api()
            val owner = RequestOwner(vm.repository.session.cacheScope())
            val id = api.books().items.first { it.title == "Portable Pages" }.id
            val checkpoint = api.bookProgress(id, "reading", owner)
            api.saveBookProgress(id, "reading", JsonObject().apply {
                addProperty("session_id", UUID.randomUUID().toString())
                addProperty("device_id", "android-bookshelf-fixture")
                addProperty("base_version", checkpoint.version)
                addProperty("sequence", 1)
                addProperty("spine_index", 0)
                addProperty("block_index", 0)
                addProperty("char_offset", 0)
                addProperty("reading_mode", "scroll")
            }, owner)
            id
        }
        compose.onAllNodes(book).onFirst().performClick()
        compose.onNodeWithText(uiString(R.string.books_read)).performClick()
        val chapter = hasText("Chapter 1 — A Window", substring = false)
        compose.waitUntil(15_000) { compose.onAllNodes(chapter).fetchSemanticsNodes().isNotEmpty() }
        val paginated = compose.onAllNodesWithText(uiString(R.string.books_pages))
        if (paginated.fetchSemanticsNodes().isNotEmpty()) paginated.onFirst().performClick()
        compose.onNodeWithText(uiString(R.string.books_scroll)).assertIsDisplayed()
        capture("reader-scroll.png")
        val stage = compose.onNodeWithTag("book-reader-stage").getBoundsInRoot()
        compose.onNodeWithText(uiString(R.string.books_contents)).performClick()
        compose.onNodeWithText("Chapter 2 — The Door").assertIsDisplayed()
        assertTrue(compose.onNodeWithTag("book-reader-stage").getBoundsInRoot() == stage)
        capture("reader-contents.png")
        compose.onNodeWithText("Chapter 2 — The Door").performClick()
        compose.waitUntil(15_000) { compose.onAllNodesWithText("Chapter 2 — The Door").fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText(uiString(R.string.books_contents)) and hasClickAction()).performClick()
        compose.onNodeWithText("Chapter 1 — A Window").performClick()
        compose.waitUntil(15_000) { compose.onAllNodes(chapter).fetchSemanticsNodes().isNotEmpty() }
        val first = compose.onNodeWithText("Chapter 1 — A Window")
        first.performSemanticsAction(SemanticsActions.SetSelection) { select -> assertTrue(select(0, 7, false)) }
        compose.onNodeWithText(uiString(R.string.books_annotate)).performClick()
        compose.onNodeWithText(uiString(R.string.books_amber)).performClick()
        compose.waitUntil(10_000) {
            runBlocking { vm.repository.api().bookAnnotations(bookId).items }.any {
                it.startBlock == 0 && it.startOffset == 0 && it.endOffset == 7 && it.color == "amber"
            }
        }
        compose.onNodeWithText(uiString(R.string.books_scroll)).performClick()
        compose.onNodeWithText(uiString(R.string.books_pages)).assertIsDisplayed()
        capture("reader-pages.png")
        val mark = "Offset fixture ${UUID.randomUUID().toString().take(8)}"
        val offset = 1900
        val baseline = runBlocking {
            vm.repository.api().addBookBookmark(bookId, JsonObject().apply {
                addProperty("kind", "ebook")
                addProperty("spine_index", 0)
                addProperty("block_index", 1)
                addProperty("char_offset", offset)
                addProperty("excerpt", mark)
            }, RequestOwner(vm.repository.session.cacheScope()))
            vm.repository.api().bookBookmarks(bookId).items.size
        }
        compose.onNodeWithContentDescription(uiString(R.string.books_tools)).performClick()
        compose.onNodeWithText(uiString(R.string.books_marks)).performClick()
        compose.waitUntil(15_000) { compose.onAllNodesWithText(mark).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(mark).performClick()
        compose.onNodeWithText(uiString(R.string.books_pages)).performClick()
        compose.onNodeWithContentDescription(uiString(R.string.books_tools)).performClick()
        capture("reader-tools.png")
        compose.onNodeWithText("A+").performClick()
        compose.onNodeWithText(uiString(R.string.books_add_mark)).performClick()
        compose.waitUntil(10_000) {
            val items = runBlocking { vm.repository.api().bookBookmarks(bookId).items }
            items.size > baseline && items.last().get("char_offset").asInt == offset &&
                items.last().get("block_index").asInt == 1
        }
        compose.onNodeWithContentDescription(uiString(R.string.books_tools)).performClick()
        compose.runOnIdle { vm.settings.appearance("dark") }
        compose.onNodeWithText(uiString(R.string.books_dark)).performClick()
        compose.onNode(hasText(uiString(R.string.books_contents)) and hasClickAction()).performClick()
        compose.onNodeWithText("Chapter 2 — The Door").assertIsDisplayed()
        capture("reader-contents-dark.png")
        compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.appearance("system") }
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
