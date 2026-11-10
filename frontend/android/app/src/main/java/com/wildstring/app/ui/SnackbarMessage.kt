package com.wildstring.app.ui

/**
 * Picks the message the shared snackbar shows next.
 *
 * A fresh action confirmation ([mutationMessage]) wins over a lingering [error]: the error is
 * also shown inline with its retry button and comes back on the snackbar as soon as the
 * confirmation is acknowledged, whereas an error that stayed set used to hide every later
 * confirmation. Podcast sync problems ([syncError]) come last.
 */
internal fun nextSnackbarMessage(error: String?, mutationMessage: String?, syncError: String?): String? =
    mutationMessage ?: error ?: syncError
