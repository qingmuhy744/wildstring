import Foundation

public func KitL10n(_ key: String, _ args: CVarArg...) -> String {
    let isChinese = isKitChineseLocale()
    let lang = isChinese ? "zh-Hans" : "en"
    let template = resolveKitString(key: key, lang: lang, isChinese: isChinese)
    guard !args.isEmpty else { return template }
    return String(format: template, locale: Locale(identifier: lang), arguments: args)
}

private var isRunningTests: Bool {
    if NSClassFromString("XCTestCase") != nil { return true }
    let info = ProcessInfo.processInfo
    if info.environment["XCTestConfigurationFilePath"] != nil { return true }
    let procName = info.processName.lowercased()
    if procName.contains("test") { return true }
    if info.arguments.contains(where: { $0.lowercased().contains("test") }) { return true }
    return false
}

private func isKitChineseLocale() -> Bool {
    let pref = UserDefaults.standard.string(forKey: "interfaceLanguage") ?? "auto"
    if pref == "zh" { return true }
    if pref == "en" { return false }
    if isRunningTests { return true }
    let sys = Locale.preferredLanguages.first ?? "en"
    return sys.lowercased().hasPrefix("zh")
}

private func resolveKitString(key: String, lang: String, isChinese: Bool) -> String {
    for base in [Bundle.main] + Bundle.allBundles {
        if let path = base.path(forResource: lang, ofType: "lproj"),
           let lproj = Bundle(path: path) {
            let val = lproj.localizedString(forKey: key, value: "\u{0000}", table: nil)
            if val != "\u{0000}" { return val }
        }
    }
    if isChinese, let zh = kitZhTable[key] { return zh }
    if !isChinese, let en = kitEnTable[key] { return en }
    return kitZhTable[key] ?? kitEnTable[key] ?? key
}

private let kitZhTable: [String: String] = [
    "kit.agent.newConversation": "\u{65B0}\u{5BF9}\u{8BDD}",
    "kit.metadata.listSeparator": "\u{3001}",
    "kit.playback.audioMissing": "\u{97F3}\u{9891}\u{6587}\u{4EF6}\u{7F3A}\u{5931}\u{FF0C}\u{8BF7}\u{6062}\u{590D}\u{6587}\u{4EF6}\u{5E76}\u{91CD}\u{65B0}\u{626B}\u{63CF}\u{540E}\u{91CD}\u{8BD5}",
    "kit.playback.audioSessionFailed": "\u{65E0}\u{6CD5}\u{542F}\u{7528}\u{97F3}\u{9891}\u{64AD}\u{653E}\u{FF0C}\u{8BF7}\u{91CD}\u{8BD5}\u{FF1A}%@",
    "kit.playback.audioTempUnavailable": "\u{97F3}\u{9891}\u{6587}\u{4EF6}\u{6682}\u{4E0D}\u{53EF}\u{7528}\u{FF0C}\u{8BF7}\u{6062}\u{590D}\u{6587}\u{4EF6}\u{5E76}\u{91CD}\u{65B0}\u{626B}\u{63CF}\u{540E}\u{91CD}\u{8BD5}",
    "kit.playback.audioUnreadable": "\u{670D}\u{52A1}\u{7AEF}\u{65E0}\u{6CD5}\u{8BFB}\u{53D6}\u{97F3}\u{9891}\u{6587}\u{4EF6}\u{FF0C}\u{8BF7}\u{68C0}\u{67E5}\u{5B58}\u{50A8}\u{540E}\u{91CD}\u{8BD5}",
    "kit.playback.authExpired": "\u{767B}\u{5F55}\u{5DF2}\u{8FC7}\u{671F}\u{FF0C}\u{8BF7}\u{91CD}\u{65B0}\u{767B}\u{5F55}",
    "kit.playback.cannotPlay": "\u{65E0}\u{6CD5}\u{64AD}\u{653E}\u{8FD9}\u{9996}\u{6B4C}\u{66F2}",
    "kit.playback.cannotPlayDebug": "\u{65E0}\u{6CD5}\u{64AD}\u{653E}\u{8FD9}\u{9996}\u{6B4C}\u{66F2}\u{FF08}%@ %d\u{FF09}",
    "kit.playback.cannotPlayStatus": "\u{65E0}\u{6CD5}\u{64AD}\u{653E}\u{FF08}%d\u{FF09}",
    "kit.playback.episodesReadFailed": "\u{6682}\u{65F6}\u{8BFB}\u{4E0D}\u{5230}\u{8282}\u{76EE}\u{5355}\u{96C6}\u{FF0C}\u{5F85}\u{64AD}\u{961F}\u{5217}\u{5DF2}\u{4FDD}\u{7559}\u{FF0C}\u{53EF}\u{4EE5}\u{91CD}\u{8BD5}\u{3002}",
    "kit.playback.fileChanged": "\u{97F3}\u{9891}\u{6587}\u{4EF6}\u{5DF2}\u{53D8}\u{5316}\u{FF0C}\u{8BF7}\u{91CD}\u{65B0}\u{626B}\u{63CF}\u{540E}\u{91CD}\u{8BD5}",
    "kit.playback.itemUnavailable": "\u{300C}%@\u{300D}\u{4E0D}\u{53EF}\u{7528}\u{3002}",
    "kit.playback.nextEpisodeUnavailable": "\u{4E0B}\u{4E00}\u{96C6}\u{6682}\u{65F6}\u{6253}\u{4E0D}\u{5F00}\u{3002}\u{5F85}\u{64AD}\u{961F}\u{5217}\u{8FD8}\u{5728}\u{FF0C}\u{53EF}\u{4EE5}\u{91CD}\u{8BD5}\u{3002}",
    "kit.playback.noPlayableTracks": "\u{6CA1}\u{6709}\u{53EF}\u{64AD}\u{653E}\u{7684}\u{6B4C}\u{66F2}\u{3002}\u{8BF7}\u{6062}\u{590D}\u{6587}\u{4EF6}\u{5E76}\u{91CD}\u{65B0}\u{626B}\u{63CF}\u{FF0C}\u{5237}\u{65B0}\u{5217}\u{8868}\u{540E}\u{91CD}\u{8BD5}\u{3002}",
    "kit.playback.outputAacTranscode": "AAC \u{8F6C}\u{7801}",
    "kit.playback.outputOffline": "\u{79BB}\u{7EBF}",
    "kit.playback.outputOriginal": "\u{539F}\u{97F3}",
    "kit.playback.outputOriginalCodec": "\u{539F}\u{97F3} \u{00B7} %@",
    "kit.playback.podcastProgressConflict": "\u{8FD9}\u{96C6}\u{5728}\u{5176}\u{4ED6}\u{8BBE}\u{5907}\u{6709}\u{66F4}\u{65B0}\u{7684}\u{8FDB}\u{5EA6}",
    "kit.playback.queueLimit": "\u{64AD}\u{653E}\u{961F}\u{5217}\u{6700}\u{591A} 5000 \u{9996}\u{3002}",
    "kit.playback.seekIncomplete": "\u{8DF3}\u{8F6C}\u{672A}\u{5B8C}\u{6210}\u{FF0C}\u{8BF7}\u{91CD}\u{8BD5}",
    "kit.playback.trackNotFound": "\u{8FD9}\u{9996}\u{6B4C}\u{66F2}\u{5DF2}\u{4E0D}\u{5728}\u{66F2}\u{5E93}",
    "kit.playback.trackUnavailableRetry": "\u{300C}%@\u{300D}%@\u{3002}\u{8BF7}\u{6062}\u{590D}\u{6587}\u{4EF6}\u{5E76}\u{91CD}\u{65B0}\u{626B}\u{63CF}\u{FF0C}\u{5237}\u{65B0}\u{5217}\u{8868}\u{540E}\u{91CD}\u{8BD5}\u{3002}",
    "kit.playback.transcodeFallback": "\u{8F6C}\u{7801}\u{6682}\u{4E0D}\u{53EF}\u{7528}\u{FF0C}\u{5DF2}\u{56DE}\u{9000}\u{539F}\u{97F3}",
    "kit.playback.transcodeStreamFailedFallback": "\u{8F6C}\u{7801}\u{6D41}\u{5931}\u{8D25}\u{FF0C}\u{5DF2}\u{56DE}\u{9000}\u{539F}\u{97F3}",
    "kit.podcast.conflictMessage": "\u{961F}\u{5217}\u{5728}\u{5176}\u{4ED6}\u{8BBE}\u{5907}\u{4E0A}\u{6709}\u{66F4}\u{65B0}\u{3002}\u{672C}\u{673A}\u{961F}\u{5217}\u{5DF2}\u{4FDD}\u{7559}\u{3002}\u{53EF}\u{4EE5}\u{9009}\u{62E9}\u{4F7F}\u{7528}\u{670D}\u{52A1}\u{5668}\u{4E0A}\u{7684}\u{961F}\u{5217}\u{FF0C}\u{6216}\u{7528}\u{672C}\u{673A}\u{8986}\u{76D6}\u{3002}",
    "kit.podcast.defaultArtist": "\u{7535}\u{53F0}",
    "kit.podcast.enqueued": "\u{5DF2}\u{52A0}\u{5165}\u{5F85}\u{64AD}",
    "kit.podcast.enqueuedNext": "\u{5DF2}\u{52A0}\u{5165}\u{5F85}\u{64AD} \u{00B7} \u{4E0B}\u{4E00}\u{96C6}\u{64AD}\u{653E}",
    "kit.podcast.err401": "\u{767B}\u{5F55}\u{5DF2}\u{5931}\u{6548}\u{FF0C}\u{8BF7}\u{91CD}\u{65B0}\u{767B}\u{5F55}\u{540E}\u{518D}\u{8BD5}\u{3002}",
    "kit.podcast.err403": "\u{6CA1}\u{6709}\u{6743}\u{9650}\u{4FEE}\u{6539}\u{8FD9}\u{4E2A}\u{5217}\u{8868}\u{3002}",
    "kit.podcast.err404": "\u{8FD9}\u{96C6}\u{5DF2}\u{7ECF}\u{4E0D}\u{5728}\u{670D}\u{52A1}\u{5668}\u{4E0A}\u{3002}",
    "kit.podcast.err422": "\u{670D}\u{52A1}\u{5668}\u{6CA1}\u{6709}\u{63A5}\u{53D7}\u{8FD9}\u{6B21}\u{4FEE}\u{6539}\u{3002}",
    "kit.podcast.errNetwork": "\u{7F51}\u{7EDC}\u{8FDE}\u{63A5}\u{4E2D}\u{65AD}\u{3002}",
    "kit.podcast.errStatus": "\u{670D}\u{52A1}\u{5668}\u{8FD4}\u{56DE} %d\u{3002}",
    "kit.podcast.errUnavailable": "\u{7F51}\u{7EDC}\u{6216}\u{6570}\u{636E}\u{6682}\u{65F6}\u{4E0D}\u{53EF}\u{7528}\u{3002}",
    "kit.podcast.inboxAddFailed": "\u{6CA1}\u{80FD}\u{52A0}\u{5165}\u{7A0D}\u{540E}\u{542C}\u{3002}%@ \u{53EF}\u{4EE5}\u{91CD}\u{8BD5}\u{3002}",
    "kit.podcast.inboxReadFailed": "\u{6682}\u{65F6}\u{8BFB}\u{4E0D}\u{5230}\u{7A0D}\u{540E}\u{542C}\u{3002}%@ \u{53EF}\u{4EE5}\u{91CD}\u{8BD5}\u{3002}",
    "kit.podcast.inboxRemoveFailed": "\u{6CA1}\u{80FD}\u{79FB}\u{51FA}\u{7A0D}\u{540E}\u{542C}\u{3002}%@ \u{53EF}\u{4EE5}\u{91CD}\u{8BD5}\u{3002}",
    "kit.podcast.loadingEpisode": "\u{6B63}\u{5728}\u{8BFB}\u{53D6}\u{5355}\u{96C6}\u{2026}",
    "kit.podcast.prefReadFailed": "\u{6682}\u{65F6}\u{8BFB}\u{4E0D}\u{5230}\u{65B0}\u{96C6}\u{5904}\u{7406}\u{3002}%@ \u{53EF}\u{4EE5}\u{91CD}\u{8BD5}\u{3002}",
    "kit.podcast.prefSaveFailed": "\u{6CA1}\u{80FD}\u{4FDD}\u{5B58}\u{65B0}\u{96C6}\u{5904}\u{7406}\u{3002}%@ \u{53EF}\u{4EE5}\u{91CD}\u{8BD5}\u{3002}",
    "kit.podcast.queueFull": "\u{5F85}\u{64AD}\u{961F}\u{5217}\u{5DF2}\u{6709} %d \u{96C6}\u{FF0C}\u{8FD9}\u{4E00}\u{96C6}\u{6CA1}\u{6709}\u{52A0}\u{5165}\u{3002}",
    "kit.podcast.removedFromQueue": "\u{5DF2}\u{4ECE}\u{5F85}\u{64AD}\u{6E05}\u{5355}\u{79FB}\u{9664}",
    "kit.podcast.syncFailed": "\u{6682}\u{65F6}\u{65E0}\u{6CD5}\u{540C}\u{6B65}\u{FF0C}\u{672C}\u{673A}\u{64AD}\u{653E}\u{4E0D}\u{53D7}\u{5F71}\u{54CD}\u{3002}%@ \u{53EF}\u{4EE5}\u{91CD}\u{8BD5}\u{3002}",
    "kit.review.keyValueFormat": "%@\u{FF1A}%@",
    "kit.review.no": "\u{5426}",
    "kit.review.pairSeparator": "\u{FF1B}",
    "kit.review.yes": "\u{662F}",
    "kit.routes.accountMismatch": "\u{7EBF}\u{8DEF}\u{7684}\u{670D}\u{52A1}\u{5668}\u{6216}\u{8D26}\u{53F7}\u{4E0D}\u{4E00}\u{81F4}",
    "kit.routes.authError": "\u{5F53}\u{524D}\u{7EBF}\u{8DEF}\u{8BA4}\u{8BC1}\u{6216}\u{6743}\u{9650}\u{9519}\u{8BEF}\u{FF08}%d\u{FF09}",
    "kit.routes.defaultName": "\u{9ED8}\u{8BA4}\u{7EBF}\u{8DEF}",
    "kit.routes.differentServer": "\u{8FD9}\u{6761}\u{7EBF}\u{8DEF}\u{4E0D}\u{5C5E}\u{4E8E}\u{5F53}\u{524D}\u{670D}\u{52A1}\u{5668}",
    "kit.routes.duplicateOrigin": "\u{8BE5}\u{5730}\u{5740}\u{6216}\u{540C}\u{6E90}\u{7EBF}\u{8DEF}\u{5DF2}\u{7ECF}\u{4FDD}\u{5B58}",
    "kit.routes.invalidNameLength": "\u{8BF7}\u{586B}\u{5199} 1\u{2013}80 \u{5B57}\u{7684}\u{7EBF}\u{8DEF}\u{540D}\u{79F0}",
    "kit.routes.manualFailed": "\u{624B}\u{52A8}\u{7EBF}\u{8DEF}\u{8FDE}\u{63A5}\u{5931}\u{8D25}\u{FF0C}\u{672A}\u{5207}\u{6362}\u{7EBF}\u{8DEF}",
    "kit.routes.manualUnavailable": "\u{624B}\u{52A8}\u{7EBF}\u{8DEF}\u{4E0D}\u{53EF}\u{7528}\u{FF0C}\u{8BF7}\u{91CD}\u{65B0}\u{767B}\u{5F55}\u{6216}\u{5207}\u{56DE} Fallback",
    "kit.routes.noAvailableRoute": "\u{6CA1}\u{6709}\u{53EF}\u{7528}\u{7684}\u{5DF2}\u{767B}\u{5F55}\u{7EBF}\u{8DEF}\u{FF0C}\u{8BF7}\u{68C0}\u{67E5}\u{7F51}\u{7EDC}\u{6216}\u{91CD}\u{65B0}\u{767B}\u{5F55}",
    "kit.routes.saved": "\u{7EBF}\u{8DEF}\u{5DF2}\u{72EC}\u{7ACB}\u{767B}\u{5F55}\u{5E76}\u{4FDD}\u{5B58}",
    "kit.routes.selectFailed": "\u{7EBF}\u{8DEF}\u{9009}\u{62E9}\u{672A}\u{5B8C}\u{6210}\u{FF0C}\u{5DF2}\u{4FDD}\u{7559}\u{539F}\u{6A21}\u{5F0F}\u{548C}\u{8FDE}\u{63A5}\u{FF1B}\u{8BF7}\u{68C0}\u{67E5}\u{7F51}\u{7EDC}\u{6216}\u{91CD}\u{65B0}\u{767B}\u{5F55}",
    "kit.routes.sessionExpired": "\u{5F53}\u{524D}\u{7EBF}\u{8DEF}\u{767B}\u{5F55}\u{5DF2}\u{8FC7}\u{671F}\u{FF0C}\u{8BF7}\u{91CD}\u{65B0}\u{767B}\u{5F55}",
    "kit.routes.upgradeRequired": "\u{8BF7}\u{5347}\u{7EA7}\u{670D}\u{52A1}\u{7AEF}\u{5E76}\u{767B}\u{5F55}\u{540E}\u{518D}\u{6DFB}\u{52A0}\u{7EBF}\u{8DEF}",
    "kit.track.missing": "\u{6587}\u{4EF6}\u{7F3A}\u{5931}",
    "kit.track.unreadable": "\u{6587}\u{4EF6}\u{65E0}\u{6CD5}\u{8BFB}\u{53D6}",
]

private let kitEnTable: [String: String] = [
    "kit.agent.newConversation": "New Conversation",
    "kit.metadata.listSeparator": ", ",
    "kit.playback.audioMissing": "Audio file missing. Restore the file and rescan to try again",
    "kit.playback.audioSessionFailed": "Unable to start audio playback, please try again: %@",
    "kit.playback.audioTempUnavailable": "Audio file temporarily unavailable. Restore the file and rescan to try again",
    "kit.playback.audioUnreadable": "Server cannot read audio file. Check storage and try again",
    "kit.playback.authExpired": "Session expired, please sign in again",
    "kit.playback.cannotPlay": "Unable to play this track",
    "kit.playback.cannotPlayDebug": "Unable to play this track (%@ %d)",
    "kit.playback.cannotPlayStatus": "Unable to play (%d)",
    "kit.playback.episodesReadFailed": "Unable to load show episodes right now. Queue is preserved, please try again.",
    "kit.playback.fileChanged": "Audio file changed. Please rescan and try again",
    "kit.playback.itemUnavailable": "\"%@\" is unavailable.",
    "kit.playback.nextEpisodeUnavailable": "Unable to open next episode right now. Queue is preserved, please try again.",
    "kit.playback.noPlayableTracks": "No playable tracks. Restore the files, rescan, and refresh the list to try again.",
    "kit.playback.outputAacTranscode": "AAC Transcode",
    "kit.playback.outputOffline": "Offline",
    "kit.playback.outputOriginal": "Original",
    "kit.playback.outputOriginalCodec": "Original \u{00B7} %@",
    "kit.playback.podcastProgressConflict": "This episode has newer progress on another device",
    "kit.playback.queueLimit": "Playback queue is limited to 5,000 tracks.",
    "kit.playback.seekIncomplete": "Seek incomplete, please try again",
    "kit.playback.trackNotFound": "This track is no longer in the library",
    "kit.playback.trackUnavailableRetry": "\"%@\" %@. Restore the file, rescan, and refresh the list to try again.",
    "kit.playback.transcodeFallback": "Transcoding unavailable, fell back to original",
    "kit.playback.transcodeStreamFailedFallback": "Transcode stream failed, fell back to original",
    "kit.podcast.conflictMessage": "Queue was updated on another device. Local queue is preserved. Choose the server queue or overwrite with local.",
    "kit.podcast.defaultArtist": "Podcasts",
    "kit.podcast.enqueued": "Added to Up Next",
    "kit.podcast.enqueuedNext": "Added to Up Next \u{00B7} Play next",
    "kit.podcast.err401": "Session expired, please sign in again.",
    "kit.podcast.err403": "You do not have permission to modify this list.",
    "kit.podcast.err404": "This episode is no longer on the server.",
    "kit.podcast.err422": "The server did not accept this change.",
    "kit.podcast.errNetwork": "Network connection interrupted.",
    "kit.podcast.errStatus": "Server returned %d.",
    "kit.podcast.errUnavailable": "Network or data temporarily unavailable.",
    "kit.podcast.inboxAddFailed": "Could not add to Listen Later. %@ Please try again.",
    "kit.podcast.inboxReadFailed": "Unable to load Listen Later right now. %@ Please try again.",
    "kit.podcast.inboxRemoveFailed": "Could not remove from Listen Later. %@ Please try again.",
    "kit.podcast.loadingEpisode": "Loading episode\u{2026}",
    "kit.podcast.prefReadFailed": "Unable to load new episode settings right now. %@ Please try again.",
    "kit.podcast.prefSaveFailed": "Could not save new episode settings. %@ Please try again.",
    "kit.podcast.queueFull": "Up Next queue already has %d episodes; this episode was not added.",
    "kit.podcast.removedFromQueue": "Removed from Up Next",
    "kit.podcast.syncFailed": "Unable to sync right now; local playback is unaffected. %@ Please try again.",
    "kit.review.keyValueFormat": "%@: %@",
    "kit.review.no": "No",
    "kit.review.pairSeparator": "; ",
    "kit.review.yes": "Yes",
    "kit.routes.accountMismatch": "Server or account mismatch for this route",
    "kit.routes.authError": "Authentication or permission error on current route (%d)",
    "kit.routes.defaultName": "Default Route",
    "kit.routes.differentServer": "This route does not belong to the current server",
    "kit.routes.duplicateOrigin": "This address or a same-origin route is already saved",
    "kit.routes.invalidNameLength": "Please enter a route name between 1 and 80 characters",
    "kit.routes.manualFailed": "Manual route connection failed; route not switched",
    "kit.routes.manualUnavailable": "Manual route unavailable. Sign in again or switch back to Fallback",
    "kit.routes.noAvailableRoute": "No signed-in route available. Check network or sign in again",
    "kit.routes.saved": "Route signed in and saved independently",
    "kit.routes.selectFailed": "Route selection incomplete; previous mode and connection kept. Check network or sign in again",
    "kit.routes.sessionExpired": "Current route session expired. Please sign in again",
    "kit.routes.upgradeRequired": "Please upgrade the server and sign in before adding routes",
    "kit.track.missing": "File missing",
    "kit.track.unreadable": "File unreadable",
]
