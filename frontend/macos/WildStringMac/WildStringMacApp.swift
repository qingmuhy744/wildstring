import AppKit
import SwiftUI

@main
struct WildStringMacApp: App {
    @State private var session = MacSession()
    @AppStorage("menuBarPlayerEnabled") private var menuBarPlayerEnabled = true

    init() {
        MacAppearance.apply(UserDefaults.standard.string(forKey: "macAppearance") ?? "system")
    }

    var body: some Scene {
        Window(L10n("macApp.windowTitle"), id: "main") {
            MacRootView(session: session)
        }
        .commands { MacMenus(session: session) }

        MenuBarExtra(isInserted: $menuBarPlayerEnabled) {
            MenuBarPlayer(session: session)
        } label: {
            Image("MenuBarIcon").renderingMode(.template).accessibilityLabel(L10n("macApp.menuBarPlayerAccessibility"))
        }
        .menuBarExtraStyle(.window)
    }
}

private struct MacMenus: Commands {
    let session: MacSession
    @AppStorage("macAppearance") private var appearance = "system"

    private var isPodcast: Bool {
        session.playback?.currentItem?.trackID.hasPrefix("podcast_ep_") == true
    }

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button(L10n("macApp.checkForUpdates")) {
                Task { await session.updater.checkForUpdates(manual: true) }
            }
        }
        CommandGroup(replacing: .appSettings) {
            Button(L10n("macApp.settings")) { navigate(.settings) }
                .keyboardShortcut(",", modifiers: .command)
                .disabled(session.client == nil)
        }
        CommandGroup(after: .textEditing) {
            Divider()
            Button(L10n("macApp.searchLibrary")) {
                navigate(.search)
                session.focusLibrarySearch = true
            }.keyboardShortcut("f", modifiers: .command).disabled(session.client == nil)
        }
        CommandMenu(L10n("macApp.menuGo")) {
            Group {
            Button(L10n("macApp.goHome")) { navigate(.home) }.keyboardShortcut("0", modifiers: .command)
            Button(L10n("macApp.goSearch")) { navigate(.search) }.keyboardShortcut("f", modifiers: [.command, .shift])
            Button(L10n("macApp.goTracks")) { navigate(.tracks) }.keyboardShortcut("1", modifiers: .command)
            Button(L10n("macApp.goAlbums")) { navigate(.albums) }.keyboardShortcut("2", modifiers: .command)
            Button(L10n("macApp.goArtists")) { navigate(.artists) }.keyboardShortcut("3", modifiers: .command)
            Button(L10n("macApp.goPlaylists")) { navigate(.playlists) }.keyboardShortcut("4", modifiers: .command)
            Button(L10n("macApp.goFavorites")) { navigate(.favorites) }.keyboardShortcut("5", modifiers: .command)
            Divider()
            Button(L10n("macApp.goDiscover")) { navigate(.discover) }.keyboardShortcut("6", modifiers: .command)
            Button(L10n("macApp.goPodcasts")) { navigate(.podcasts) }.keyboardShortcut("7", modifiers: .command)
            Button(L10n("macApp.goAssistant")) { navigate(.assistant) }.keyboardShortcut("8", modifiers: .command)
            Divider()
            Button(L10n("macApp.goListening")) { navigate(.listening) }
            Button(L10n("macApp.goDevices")) { navigate(.devices) }
            Button(L10n("macApp.goNotifications")) { navigate(.notifications) }
            Button(L10n("macApp.goDrafts")) { navigate(.drafts) }
            if session.canManage { Button(L10n("macApp.goManage")) { navigate(.manage) } }
            }.disabled(session.client == nil)
        }
        CommandMenu(L10n("macApp.menuControls")) {
            Button(L10n("macApp.playPause")) { session.playback?.togglePlayPause() }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(session.playback?.currentItem == nil || session.page == .assistant)
            Button(isPodcast ? L10n("macApp.rewind15") : L10n("macApp.previousTrack")) {
                if isPodcast {
                    session.seek(by: -15)
                } else {
                    session.playback?.previous()
                }
            }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(session.playback == nil)
            Button(isPodcast ? L10n("macApp.fastForward30") : L10n("macApp.nextTrack")) {
                if isPodcast {
                    session.seek(by: 30)
                } else {
                    session.playback?.next()
                }
            }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(session.playback == nil)
            Button(L10n("macApp.shuffle")) { session.playback?.toggleShuffle() }
                .keyboardShortcut("s", modifiers: [.command, .option])
                .disabled(session.playback == nil)
            Button(L10n("macApp.repeatMode")) { session.playback?.cycleRepeatMode() }
                .keyboardShortcut("r", modifiers: [.command, .option])
                .disabled(session.playback == nil)
            Divider()
            Button(L10n("macApp.rewind15")) { session.seek(by: -15) }
                .keyboardShortcut(.leftArrow, modifiers: [.command, .option])
                .disabled(session.playback?.currentItem == nil)
            Button(L10n("macApp.fastForward30")) { session.seek(by: 30) }
                .keyboardShortcut(.rightArrow, modifiers: [.command, .option])
                .disabled(session.playback?.currentItem == nil)
            Menu(L10n("macApp.sleepTimer")) {
                Button(L10n("macApp.sleep15Min")) { session.playback?.setSleepTimer(minutes: 15) }
                Button(L10n("macApp.sleep30Min")) { session.playback?.setSleepTimer(minutes: 30) }
                Button(L10n("macApp.sleep60Min")) { session.playback?.setSleepTimer(minutes: 60) }
                Button(L10n("macApp.sleepAfterTrack")) { session.playback?.sleepAfterCurrentTrack() }
                Button(L10n("macApp.cancelSleepTimer")) { session.playback?.cancelSleepTimer() }
            }.disabled(session.playback?.currentItem == nil)
        }
        CommandMenu(L10n("macApp.menuView")) {
            Button(session.showLyrics ? L10n("macApp.hideLyrics") : L10n("macApp.showLyrics")) { session.showLyrics.toggle() }
                .keyboardShortcut("l", modifiers: .command)
            Button(session.showQueue ? L10n("macApp.hideQueue") : L10n("macApp.showQueue")) { session.showQueue.toggle() }
                .keyboardShortcut("j", modifiers: [.command, .option])
            Button(session.desktopLyricsVisible ? L10n("macApp.closeDesktopLyrics") : L10n("macApp.openDesktopLyrics")) {
                NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
            }
            .keyboardShortcut("l", modifiers: [.command, .shift])
            Button(session.showFullscreen ? L10n("macApp.collapseFullscreen") : L10n("macApp.fullscreen")) {
                session.showFullscreen.toggle()
            }
            .keyboardShortcut("f", modifiers: [.command, .shift])
            .disabled(session.playback?.currentItem == nil && !session.showFullscreen)
            Divider()
            Picker(L10n("macApp.appearance"), selection: $appearance) {
                Text(L10n("macApp.themeSystem")).tag("system")
                Text(L10n("macApp.themeLight")).tag("light")
                Text(L10n("macApp.themeDark")).tag("dark")
            }
        }
    }

    private func navigate(_ page: MacPage) {
        session.showFullscreen = false
        session.page = page
        NSApp.activate(ignoringOtherApps: true)
    }
}
