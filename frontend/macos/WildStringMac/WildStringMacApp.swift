import SwiftUI

@main
struct WildStringMacApp: App {
    @State private var session = MacSession()
    @AppStorage("menuBarPlayerEnabled") private var menuBarPlayerEnabled = true

    var body: some Scene {
        WindowGroup {
            MacRootView(session: session)
        }
        .commands { MacMenus(session: session) }

        Window("桌面歌词", id: "desktop-lyrics") {
            DesktopLyricsView(session: session)
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
        .defaultSize(width: 720, height: 96)

        MenuBarExtra("野弦", systemImage: "music.note", isInserted: $menuBarPlayerEnabled) {
            MenuBarPlayer(session: session)
        }
        .menuBarExtraStyle(.window)
    }
}

private struct MacMenus: Commands {
    let session: MacSession

    var body: some Commands {
        CommandMenu("控制") {
            Button("播放/暂停") { session.playback?.togglePlayPause() }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(session.playback?.currentItem == nil)
            Button("上一首") { session.playback?.previous() }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(session.playback == nil)
            Button("下一首") { session.playback?.next() }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(session.playback == nil)
            Button("随机播放") { session.playback?.toggleShuffle() }
                .keyboardShortcut("s", modifiers: [.command, .option])
                .disabled(session.playback == nil)
            Button("循环") { session.playback?.cycleRepeatMode() }
                .keyboardShortcut("r", modifiers: [.command, .option])
                .disabled(session.playback == nil)
            Divider()
            Button("后退 15 秒") { session.seek(by: -15) }
                .keyboardShortcut(.leftArrow, modifiers: [.command, .option])
                .disabled(session.playback?.currentItem == nil)
            Button("前进 30 秒") { session.seek(by: 30) }
                .keyboardShortcut(.rightArrow, modifiers: [.command, .option])
                .disabled(session.playback?.currentItem == nil)
        }
        CommandMenu("显示") {
            Button(session.showLyrics ? "隐藏歌词" : "显示歌词") { session.showLyrics.toggle() }
                .keyboardShortcut("l", modifiers: .command)
            Button(session.showQueue ? "隐藏队列" : "显示队列") { session.showQueue.toggle() }
                .keyboardShortcut("j", modifiers: [.command, .option])
            Button("桌面歌词") {
                NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
            }
            .keyboardShortcut("l", modifiers: [.command, .shift])
        }
    }
}
