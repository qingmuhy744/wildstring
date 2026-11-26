package com.wildstring.app

import androidx.compose.ui.graphics.Color
import com.wildstring.app.ui.annotationHighlightColorOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BookAnnotationColorTest {
    @Test fun acceptsPresetsAndSixDigitHex() {
        assertEquals(Color(0xFFECCB84), annotationHighlightColorOrNull("amber"))
        assertEquals(Color(0xFF3456AB), annotationHighlightColorOrNull("#3456aB"))
    }

    @Test fun ignoresMalformedColors() {
        for (value in listOf("#abc", "3456ab", "#12345678", "#zzzzzz", "#123ABC\n")) {
            assertNull(annotationHighlightColorOrNull(value))
        }
    }
}
