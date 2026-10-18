package com.wildstring.app

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.ui.AssistantMarkdown
import com.wildstring.app.ui.safeAssistantLink
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class AssistantMarkdownTest {
    @get:Rule val compose = createComposeRule()

    @Test fun formattedAnswerCanGrowWithoutShowingRawMarkdown() {
        val text = mutableStateOf("## 比对结果\n\n你的曲库中，共有 **125 首曲目**。\n\n### 最大缺口\n\n- 第一首歌曲\n- 第二首歌曲")
        compose.setContent { MaterialTheme { Surface { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) { AssistantMarkdown(text.value) } } } }
        compose.onNodeWithText("比对结果").assertIsDisplayed()
        compose.onNodeWithText("你的曲库中，共有 125 首曲目。").assertIsDisplayed()
        compose.onNodeWithText("第一首歌曲").assertIsDisplayed()
        compose.onNodeWithText("## 比对结果").assertDoesNotExist()
        compose.runOnIdle { text.value += "\n\n最新收到的正文" }
        compose.onNodeWithText("最新收到的正文").assertExists()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val folder = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let { java.io.File(it) } ?: java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "verification")
        folder.mkdirs()
        instrumentation.uiAutomation.takeScreenshot()?.let { image ->
            java.io.File(folder, "assistant-markdown.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            image.recycle()
        }
    }

    @Test fun onlyExplicitWebLinksAreActionable() {
        assertTrue(safeAssistantLink("https://example.com/releases?q=rock"))
        listOf("javascript:alert(1)", "data:text/html,test", "file:///data/data", "https://user:secret@example.com", "//example.com", "https://").forEach { assertFalse(it, safeAssistantLink(it)) }
    }
}
