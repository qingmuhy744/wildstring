import AppKit
import SwiftUI

@main
struct WildStringMacApp: App {
    @State private var session = MacSession()
    @AppStorage("menuBarPlayerEnabled") private var menuBarPlayerEnabled = true

    var body: some Scene {
        Window("野弦", id: "main") {
            MacRootView(session: session)
        }
        .commands { MacMenus(session: session) }

        Window("桌面歌词", id: "desktop-lyrics") {
            DesktopLyricsView(session: session)
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
        .defaultSize(width: 540, height: 72)

        MenuBarExtra(isInserted: $menuBarPlayerEnabled) {
            MenuBarPlayer(session: session)
        } label: {
            Image("MenuBarIcon").renderingMode(.template).accessibilityLabel("野弦播放器")
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
        CommandGroup(replacing: .appSettings) {
            Button("设置…") { navigate(.settings) }
                .keyboardShortcut(",", modifiers: .command)
                .disabled(session.client == nil)
        }
        CommandGroup(after: .textEditing) {
            Divider()
            Button("搜索曲库") {
                navigate(.tracks)
                session.focusLibrarySearch = true
            }.keyboardShortcut("f", modifiers: .command).disabled(session.client == nil)
        }
        CommandMenu("前往") {
            Group {
            Button("全部歌曲") { navigate(.tracks) }.keyboardShortcut("1", modifiers: .command)
            Button("专辑") { navigate(.albums) }.keyboardShortcut("2", modifiers: .command)
            Button("艺人") { navigate(.artists) }.keyboardShortcut("3", modifiers: .command)
            Button("歌单") { navigate(.playlists) }.keyboardShortcut("4", modifiers: .command)
            Button("我喜欢") { navigate(.favorites) }.keyboardShortcut("5", modifiers: .command)
            Divider()
            Button("每日推荐") { navigate(.discover) }.keyboardShortcut("6", modifiers: .command)
            Button("电台") { navigate(.podcasts) }.keyboardShortcut("7", modifiers: .command)
            Button("音乐助手") { navigate(.assistant) }.keyboardShortcut("8", modifiers: .command)
            Divider()
            Button("收听记录") { navigate(.listening) }
            Button("跨设备继续") { navigate(.devices) }
            Button("通知") { navigate(.notifications) }
            Button("待确认草案") { navigate(.drafts) }
            if session.canManage { Button("管理") { navigate(.manage) } }
            }.disabled(session.client == nil)
        }
        CommandMenu("控制") {
            Button("播放/暂停") { session.playback?.togglePlayPause() }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(session.playback?.currentItem == nil || session.page == .assistant)
            Button(isPodcast ? "后退 15 秒" : "上一首") {
                if isPodcast {
                    session.seek(by: -15)
                } else {
                    session.playback?.previous()
                }
            }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(session.playback == nil)
            Button(isPodcast ? "前进 30 秒" : "下一首") {
                if isPodcast {
                    session.seek(by: 30)
                } else {
                    session.playback?.next()
                }
            }
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
            Menu("定时暂停") {
                Button("15 分钟后") { session.playback?.setSleepTimer(minutes: 15) }
                Button("30 分钟后") { session.playback?.setSleepTimer(minutes: 30) }
                Button("60 分钟后") { session.playback?.setSleepTimer(minutes: 60) }
                Button("当前曲目结束后") { session.playback?.sleepAfterCurrentTrack() }
                Button("取消定时") { session.playback?.cancelSleepTimer() }
            }.disabled(session.playback?.currentItem == nil)
        }
        CommandMenu("显示") {
            Button(session.showLyrics ? "隐藏歌词" : "显示歌词") { session.showLyrics.toggle() }
                .keyboardShortcut("l", modifiers: .command)
            Button(session.showQueue ? "隐藏队列" : "显示队列") { session.showQueue.toggle() }
                .keyboardShortcut("j", modifiers: [.command, .option])
            Button(session.desktopLyricsVisible ? "关闭桌面歌词" : "打开桌面歌词") {
                NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
            }
            .keyboardShortcut("l", modifiers: [.command, .shift])
            Button(session.showFullscreen ? "收起全屏播放" : "全屏播放") {
                session.showFullscreen.toggle()
            }
            .keyboardShortcut("f", modifiers: [.command, .shift])
            .disabled(session.playback?.currentItem == nil && !session.showFullscreen)
            Divider()
            Picker("外观", selection: $appearance) {
                Text("跟随系统").tag("system")
                Text("浅色").tag("light")
                Text("深色").tag("dark")
            }
        }
    }

    private func navigate(_ page: MacPage) {
        session.showFullscreen = false
        session.page = page
        NSApp.activate(ignoringOtherApps: true)
    }
}
