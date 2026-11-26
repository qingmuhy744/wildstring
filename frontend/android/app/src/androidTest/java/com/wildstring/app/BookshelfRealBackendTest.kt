package com.wildstring.app

import android.content.ComponentName
import android.graphics.Bitmap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonObject
import com.wildstring.app.data.RequestOwner
import com.wildstring.app.playback.BookPlaybackService
import com.wildstring.app.ui.MusicViewModel
import com.wildstring.app.ui.classicDarkColors
import com.wildstring.app.ui.classicLightColors
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

    private fun capture(name: String, frameReady: (Bitmap) -> Boolean = { true }) {
        compose.waitForIdle()
        val run = InstrumentationRegistry.getInstrumentation()
        val output = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: run.targetContext.getExternalFilesDir(null)!!
        output.mkdirs()
        var frame: Bitmap? = null
        compose.waitUntil(5_000) {
            val image = checkNotNull(run.uiAutomation.takeScreenshot())
            if (frameReady(image)) {
                frame = image
                true
            } else {
                image.recycle()
                false
            }
        }
        val image = checkNotNull(frame)
        File(output, name).outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }

    private fun openBookshelf() {
        compose.onNodeWithTag("nav-books").performClick()
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
        openBookshelf()
        if (compose.onAllNodesWithTag("bottom-navigation").fetchSemanticsNodes().isNotEmpty()) {
            val navOrder = listOf("nav-library", "nav-podcast", "nav-search", "nav-books", "nav-mine")
                .map { compose.onNodeWithTag(it).fetchSemanticsNode().boundsInRoot.left }
            assertTrue("Bottom bar must center Discover symmetrically: $navOrder", navOrder.zipWithNext().all { (a, b) -> a < b })
        }
        val book = hasText("Portable Pages", substring = true) and hasClickAction()
        compose.waitUntil(20_000) { compose.onAllNodes(book).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("books-resume-cta").assertDoesNotExist()
        capture("bookshelf-light.png")
        compose.runOnIdle { vm.settings.appearance("dark") }
        compose.waitForIdle()
        capture("bookshelf-dark.png")
        compose.runOnIdle { vm.settings.appearance("light") }
        compose.waitForIdle()
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
        compose.waitUntil(15_000) {
            compose.onAllNodesWithText(uiString(R.string.books_read)).fetchSemanticsNodes().isNotEmpty()
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Chapter 1 — A Window").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Chapter 1 — A Window").assertIsDisplayed()
        compose.onNodeWithText("Chapter 2 — The Door").assertIsDisplayed()
        capture("book-detail-light.png")
        compose.onNodeWithTag("books-edit-toggle").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("books-edit-panel").fetchSemanticsNodes().isNotEmpty()
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("books-source-chip-itunes").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("books-source-chip-openlibrary").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("books-source-chip-google_books").assertDoesNotExist()
        capture("book-detail-edit-light.png")
        compose.runOnIdle { vm.settings.appearance("dark") }
        compose.waitForIdle()
        capture("book-detail-edit-dark.png")
        compose.runOnIdle { vm.settings.appearance("light") }
        compose.waitForIdle()
        compose.onNodeWithTag("books-edit-toggle").performScrollTo().performClick()
        if (compose.onAllNodesWithTag("bottom-navigation").fetchSemanticsNodes().isNotEmpty()) {
            compose.onNodeWithTag("nav-assistant").performClick()
            for (theme in listOf("light", "dark")) {
                val input = compose.onNodeWithTag("agent-chat-input")
                compose.runOnIdle { vm.settings.appearance(theme) }
                compose.waitUntil(15_000) {
                    input.isDisplayed() &&
                        compose.onNodeWithTag("appearance-$theme").isDisplayed() &&
                        compose.onAllNodesWithTag("bottom-navigation").fetchSemanticsNodes().isEmpty()
                }
                // The compositor can still return a bookshelf frame after semantics has switched.
                val bounds = input.fetchSemanticsNode().boundsInRoot
                val x = (bounds.left + bounds.width * 0.7f).toInt()
                val y = bounds.center.y.toInt()
                val background = (if (theme == "dark") classicDarkColors else classicLightColors).surfaceContainerLow.toArgb()
                capture("assistant-phone-$theme.png") { image -> image.getPixel(x, y) == background }
            }
            compose.runOnIdle { vm.settings.appearance("light") }
            compose.waitForIdle()
            compose.onNodeWithTag("assistant-back").performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(uiString(R.string.books_read)).fetchSemanticsNodes().isNotEmpty() &&
                    compose.onAllNodesWithTag("bottom-navigation").fetchSemanticsNodes().isNotEmpty()
            }
        }
        compose.onNodeWithText(uiString(R.string.books_read)).performClick()
        val chapter = hasText("Chapter 1 — A Window", substring = false) and
            SemanticsMatcher.keyIsDefined(SemanticsActions.SetSelection)
        val chapter2 = hasText("Chapter 2 — The Door", substring = false) and
            SemanticsMatcher.keyIsDefined(SemanticsActions.SetSelection)
        compose.waitUntil(15_000) { compose.onAllNodes(chapter).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("bottom-navigation").assertDoesNotExist()
        compose.onNodeWithTag("book-mini-player").assertDoesNotExist()
        compose.onNodeWithTag("book-reader-top-bar").assertIsDisplayed()
        compose.onNodeWithTag("book-reader-bottom-bar").assertDoesNotExist()
        compose.onNodeWithContentDescription(uiString(R.string.books_tools)).performClick()
        val paginated = compose.onAllNodesWithText(uiString(R.string.books_pages))
        if (paginated.fetchSemanticsNodes().isNotEmpty()) paginated.onFirst().performClick()
        compose.onNodeWithText(uiString(R.string.books_scroll)).assertIsDisplayed()
        compose.onNodeWithContentDescription(uiString(R.string.books_tools)).performClick()
        capture("reader-scroll.png")
        val stage = compose.onNodeWithTag("book-reader-stage").getBoundsInRoot()
        compose.onNodeWithTag("book-reader-stage").performTouchInput { click(center) }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithTag("book-reader-top-bar").fetchSemanticsNodes().isEmpty()
        }
        assertTrue(compose.onNodeWithTag("book-reader-stage").getBoundsInRoot() == stage)
        capture("reader-immersive.png")
        compose.onNodeWithTag("book-reader-stage").performTouchInput { click(center) }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithTag("book-reader-top-bar").fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(compose.onNodeWithTag("book-reader-stage").getBoundsInRoot() == stage)
        compose.onNodeWithText(uiString(R.string.books_contents)).performClick()
        compose.onNodeWithText("Chapter 2 — The Door").assertIsDisplayed()
        assertTrue(compose.onNodeWithTag("book-reader-stage").getBoundsInRoot() == stage)
        capture("reader-contents.png")
        compose.onNodeWithText("Chapter 2 — The Door").performClick()
        compose.waitUntil(15_000) { compose.onAllNodes(chapter2).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText(uiString(R.string.books_contents)) and hasClickAction()).performClick()
        compose.onNodeWithText("Chapter 1 — A Window").performClick()
        compose.waitUntil(15_000) { compose.onAllNodes(chapter).fetchSemanticsNodes().isNotEmpty() }
        val first = compose.onNode(chapter)
        first.performSemanticsAction(SemanticsActions.SetSelection) { select -> assertTrue(select(0, 7, false)) }
        compose.onNodeWithText(uiString(R.string.books_annotate)).performClick()
        compose.onNodeWithTag("book-annotation-note-input").performTextReplacement("窗边批注")
        compose.activityRule.scenario.onActivity { activity ->
            WindowCompat.getInsetsController(activity.window, activity.window.decorView).hide(WindowInsetsCompat.Type.ime())
        }
        compose.waitUntil(5_000) {
            compose.runOnIdle {
                ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == false
            }
        }
        compose.onNodeWithText(uiString(R.string.books_amber)).performClick()
        compose.onNodeWithTag("book-annotation-save").assertIsDisplayed().performClick()
        compose.waitUntil(10_000) {
            runBlocking { vm.repository.api().bookAnnotations(bookId).items }.any {
                it.startBlock == 0 && it.startOffset == 0 && it.endOffset == 7 && it.color == "amber" && it.note == "窗边批注"
            }
        }
        compose.onNodeWithContentDescription(uiString(R.string.books_tools)).performClick()
        compose.onNodeWithText(uiString(R.string.books_scroll)).performClick()
        compose.onNodeWithText(uiString(R.string.books_pages)).assertIsDisplayed()
        compose.onNodeWithTag("book-reader-tools-backdrop").performTouchInput {
            click(Offset(centerX, bottom - 40f))
        }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithTag("book-reader-tools").fetchSemanticsNodes().isEmpty()
        }
        compose.onNodeWithTag("book-reader-page-indicator").assertIsDisplayed()
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
        compose.onNodeWithContentDescription(uiString(R.string.books_tools)).performClick()
        compose.onNodeWithText(uiString(R.string.books_pages)).performClick()
        capture("reader-tools.png")
        compose.onNodeWithText("A+").performClick()
        compose.onNodeWithText(uiString(R.string.books_add_mark)).performClick()
        compose.waitUntil(10_000) {
            val items = runBlocking { vm.repository.api().bookBookmarks(bookId).items }
            items.size > baseline && items.last().get("char_offset").asInt == offset &&
                items.last().get("block_index").asInt == 1
        }
        compose.runOnIdle { vm.settings.appearance("dark") }
        compose.onNodeWithText(uiString(R.string.books_dark)).performClick()
        compose.onNodeWithContentDescription(uiString(R.string.books_tools)).performClick()
        compose.onNode(hasText(uiString(R.string.books_contents)) and hasClickAction()).performClick()
        compose.onNodeWithText("Chapter 2 — The Door").assertIsDisplayed()
        capture("reader-contents-dark.png")
        compose.onNodeWithText(uiString(R.string.books_close)).performClick()
        compose.onNodeWithContentDescription(uiString(R.string.books_back)).performClick()
        compose.onNodeWithText(uiString(R.string.books_back)).performClick()
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("book-card-resume-$bookId").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("books-resume-cta").assertDoesNotExist()
        compose.runOnIdle { vm.settings.appearance("light") }
        compose.waitForIdle()
        capture("bookshelf-in-progress-light.png")
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
        openBookshelf()
        val audio = hasText(uiString(R.string.books_audiobook), substring = true) and hasClickAction()
        compose.waitUntil(20_000) { compose.onAllNodes(audio).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(audio).onFirst().performClick()
        val listen = hasText(uiString(R.string.books_listen), substring = false) and hasClickAction()
        compose.waitUntil(15_000) { compose.onAllNodes(listen).fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("第一话：雨夜来信").fetchSemanticsNodes().isNotEmpty()
        }
        val token = SessionToken(compose.activity, ComponentName(compose.activity, BookPlaybackService::class.java))
        val connection = MediaController.Builder(compose.activity, token).buildAsync()
        val controller = connection.get(10, TimeUnit.SECONDS)
        try {
            compose.onNode(listen).performClick()
            try {
                compose.waitUntil(12_000) { compose.runOnIdle { controller.isPlaying } }
            } catch (cause: ComposeTimeoutException) {
                val state = compose.runOnIdle {
                    "items=${controller.mediaItemCount}, state=${controller.playbackState}, " +
                        "playWhenReady=${controller.playWhenReady}, error=${controller.playerError?.errorCodeName}"
                }
                throw AssertionError("Audiobook failed to start ($state)", cause)
            }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithTag("book-mini-player").fetchSemanticsNodes().isNotEmpty()
            }
            capture("book-mini-player-light.png")
            compose.onNodeWithTag("book-mini-player-open").performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithTag("book-audio-player").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithContentDescription(uiString(R.string.pod_player_rewind_15)).assertHasClickAction()
            compose.onNodeWithContentDescription(uiString(R.string.pod_player_forward_30)).assertHasClickAction()
            capture("book-audio-player-light.png")
            compose.runOnIdle { vm.settings.appearance("dark") }
            compose.waitForIdle()
            capture("book-audio-player-dark.png")
            compose.runOnIdle { vm.settings.appearance("light") }
            compose.runOnIdle { controller.pause() }
            compose.waitUntil(10_000) { compose.runOnIdle { !controller.isPlaying } }
            val progress = compose.onNodeWithContentDescription(uiString(R.string.playback_progress_label))
            progress.seekPlaybackTo(4500L)
            compose.waitUntil(10_000) { compose.runOnIdle { controller.currentPosition == 4500L } }
            progress.assertPlaybackProgress(4500L, compose.runOnIdle { controller.duration })
            compose.runOnIdle { controller.play() }
            compose.waitUntil(10_000) { compose.runOnIdle { controller.isPlaying } }
            compose.onNodeWithTag("book-audio-collapse").performClick()
            compose.waitUntil(10_000) {
                compose.onAllNodesWithTag("book-audio-player").fetchSemanticsNodes().isEmpty()
            }
            compose.onNodeWithText(uiString(R.string.books_back)).performClick()
            compose.onNodeWithTag("nav-search").performClick()
            compose.onNodeWithTag("book-mini-player").assertIsDisplayed()
            assertTrue(compose.runOnIdle { controller.isPlaying })
            assertTrue(compose.runOnIdle { controller.currentMediaItem?.mediaId?.startsWith("book:") == true })

            // Temporarily pair audiobook into Portable Pages to verify companion read+listen controls, then split back.
            compose.runOnIdle { vm.bookPlayback.stopAndClose() }
            val (portableId, audioId, audioTitle) = runBlocking {
                val api = vm.repository.api()
                val owner = RequestOwner(vm.repository.session.cacheScope())
                val items = api.books().items
                val portable = items.first { it.hasEbook }
                val audioBook = items.first { it.hasAudiobook && !it.hasEbook }
                api.pairBook(portable.id, JsonObject().apply { addProperty("other_book_id", audioBook.id) }, owner)
                Triple(portable.id, audioBook.id, audioBook.title)
            }
            try {
                openBookshelf()
                val readCard = hasText("Portable Pages", substring = true) and hasClickAction()
                compose.waitUntil(15_000) { compose.onAllNodes(readCard).fetchSemanticsNodes().isNotEmpty() }
                compose.onAllNodes(readCard).onFirst().performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithText(uiString(R.string.books_read)).fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText(uiString(R.string.books_read)).performClick()
                compose.waitUntil(15_000) {
                    compose.onAllNodesWithTag("book-reader-audio-toggle").fetchSemanticsNodes().isNotEmpty()
                }
                val stage = compose.onNodeWithTag("book-reader-stage").getBoundsInRoot()
                compose.onNodeWithTag("book-reader-audio-toggle").performClick()
                compose.waitUntil(12_000) {
                    compose.onAllNodesWithTag("book-reader-audio-bar").fetchSemanticsNodes().isNotEmpty() &&
                        compose.runOnIdle { controller.isPlaying }
                }
                assertTrue(compose.onNodeWithTag("book-reader-stage").getBoundsInRoot() == stage)
                compose.onNodeWithContentDescription(uiString(R.string.pod_player_rewind_15)).assertHasClickAction()
                compose.onNodeWithContentDescription(uiString(R.string.pod_player_forward_30)).assertHasClickAction()
                capture("reader-companion-audio-light.png")
                if (compose.onAllNodesWithTag("book-reader-pager").fetchSemanticsNodes().isEmpty()) {
                    compose.onNodeWithContentDescription(uiString(R.string.books_tools)).performClick()
                    compose.onNodeWithText(uiString(R.string.books_scroll)).performClick()
                    compose.onNodeWithTag("book-reader-tools-backdrop").performTouchInput {
                        click(Offset(centerX, centerY))
                    }
                    compose.waitUntil(5_000) {
                        compose.onAllNodesWithTag("book-reader-pager").fetchSemanticsNodes().isNotEmpty() &&
                            compose.onAllNodesWithTag("book-reader-tools").fetchSemanticsNodes().isEmpty()
                    }
                }
                compose.waitUntil(5_000) {
                    compose.onAllNodesWithTag("book-reader-audio-bar").fetchSemanticsNodes().isNotEmpty()
                }
                val pagerBounds = compose.onNodeWithTag("book-reader-pager").getBoundsInRoot()
                val audioBounds = compose.onNodeWithTag("book-reader-audio-bar").getBoundsInRoot()
                assertTrue(
                    "Paged text ($pagerBounds) must not be covered by companion audio bar ($audioBounds)",
                    pagerBounds.bottom <= audioBounds.top,
                )
                capture("reader-pages-companion-audio-light.png")
                compose.onNodeWithTag("book-reader-stage").performTouchInput { click(center) }
                compose.waitUntil(5_000) {
                    compose.onAllNodesWithTag("book-reader-top-bar").fetchSemanticsNodes().isEmpty() &&
                        compose.onAllNodesWithTag("book-reader-bottom-bar").fetchSemanticsNodes().isEmpty()
                }
                assertTrue(compose.runOnIdle { controller.isPlaying })
                assertTrue(compose.onNodeWithTag("book-reader-stage").getBoundsInRoot() == stage)
                compose.onNodeWithTag("book-reader-stage").performTouchInput { click(center) }
                compose.waitUntil(10_000) {
                    compose.onAllNodesWithTag("book-reader-audio-bar").fetchSemanticsNodes().isNotEmpty()
                }
                compose.onNodeWithTag("book-reader-audio-hide").performClick()
                compose.onNodeWithTag("book-reader-bottom-bar").assertDoesNotExist()
                assertTrue(compose.runOnIdle { controller.isPlaying })
            } finally {
                compose.runOnIdle { vm.bookPlayback.stopAndClose() }
                runBlocking {
                    val api = vm.repository.api()
                    val owner = RequestOwner(vm.repository.session.cacheScope())
                    val current = api.books().items.firstOrNull { it.id == portableId }
                    if (current != null && current.hasAudiobook) {
                        val splitRes = api.splitBook(portableId, JsonObject().apply { addProperty("carrier", "audiobook") }, owner)
                        val splitId = splitRes.get("id")?.asString
                        if (splitId != null && audioTitle != current.title) {
                            api.updateBookMetadata(splitId, JsonObject().apply { addProperty("title", audioTitle) }, owner)
                        }
                    }
                    check(api.books().items.any { it.id == portableId || it.hasEbook } && api.books().items.any { it.hasAudiobook && !it.hasEbook }) {
                        "Split recovery failed after audioId=$audioId"
                    }
                }
            }
        } finally {
            compose.runOnIdle {
                vm.bookPlayback.stopAndClose()
                controller.pause()
                controller.release()
                vm.settings.appearance("system")
                vm.repository.session.invalidate()
            }
        }
    }

}
