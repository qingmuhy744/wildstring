package com.wildstring.app

import com.wildstring.app.ui.nextSnackbarMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SnackbarMessageTest {
    @Test fun aLingeringErrorDoesNotHideANewConfirmation() {
        assertEquals("已加入播放队列", nextSnackbarMessage(error = "连接失败", mutationMessage = "已加入播放队列", syncError = null))
    }

    @Test fun theErrorReturnsOnceTheConfirmationIsAcknowledged() {
        assertEquals("连接失败", nextSnackbarMessage(error = "连接失败", mutationMessage = null, syncError = "同步失败"))
    }

    @Test fun syncErrorsComeLast() {
        assertEquals("同步失败", nextSnackbarMessage(error = null, mutationMessage = null, syncError = "同步失败"))
        assertNull(nextSnackbarMessage(error = null, mutationMessage = null, syncError = null))
    }
}
