package com.wildstring.app

import org.junit.Assert.assertEquals
import org.junit.Test

class AppLanguageTest {
    @Test fun unknownOrMissingPreferencesMeanAuto() {
        assertEquals("auto", AppLanguage.normalize(null))
        assertEquals("auto", AppLanguage.normalize("fr"))
        assertEquals("auto", AppLanguage.normalize("auto"))
        assertEquals("zh", AppLanguage.normalize("zh"))
        assertEquals("en", AppLanguage.normalize("en"))
    }
}
