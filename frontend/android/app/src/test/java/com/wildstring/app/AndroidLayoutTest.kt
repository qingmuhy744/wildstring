package com.wildstring.app

import com.wildstring.app.ui.AndroidLayoutMode
import com.wildstring.app.ui.androidLayoutMode
import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidLayoutTest {
    @Test fun rotatingAPhoneOrUsingANarrowSplitWindowKeepsPhoneNavigation() {
        for ((width, height) in listOf(390 to 844, 844 to 390, 599 to 1000, 1000 to 599)) {
            assertEquals(AndroidLayoutMode.Phone, androidLayoutMode(width, height))
        }
    }
    @Test fun unfoldedAndTabletWindowsUsePadInBothOrientations() {
        for ((width, height) in listOf(600 to 900, 900 to 600, 800 to 1200, 1200 to 800)) {
            assertEquals(AndroidLayoutMode.Pad, androidLayoutMode(width, height))
        }
    }
}
