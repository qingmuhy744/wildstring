package com.wildstring.app

import androidx.annotation.StringRes
import androidx.test.platform.app.InstrumentationRegistry

/** Match resource-backed controls in the active test locale. */
internal fun uiString(@StringRes id: Int, vararg args: Any): String =
    InstrumentationRegistry.getInstrumentation().targetContext.getString(id, *args)
