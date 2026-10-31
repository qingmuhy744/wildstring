import CoreNetwork
import CorePlayback
import SwiftUI

struct MacMusicView: View {
    let client: WildstringClient
    let playback: PlaybackService
    var favorites: MacFavorites?
    var canManage = false
    @Binding var focusSearch: Bool

    @State private var query = ""
    @State private var tracks: [Track] = []
    @State private var total = 0
    @State private var message: String?
    @State private var loading = true
    @FocusState private var searchFocused: Bool

    var body: some View {
        MacPlayableTracks(
            client: client,
            playback: playback,
            favorites: favorites,
            tracks: tracks,
            emptyTitle: message == nil ? (query.isEmpty ? "曲库是空的" : "没有找到「\(query)」") : "无法加载曲库",
            emptyDetail: message,
            canManage: canManage,
            isLoading: loading
        )
        .navigationTitle("全部歌曲")
        .toolbar {
            TextField("搜索歌曲、艺人或专辑", text: $query)
                .textFieldStyle(.roundedBorder).frame(width: 260).focused($searchFocused)
        }
        .onChange(of: focusSearch) { _, requested in
            if requested { searchFocused = true; focusSearch = false }
        }
        .onAppear {
            if focusSearch { searchFocused = true; focusSearch = false }
        }
        .safeAreaInset(edge: .bottom) {
            if tracks.count < total {
                Button("还有 \(total - tracks.count) 首") { Task { await load(reset: false) } }
                    .buttonStyle(.bordered)
                    .padding(8)
            }
        }
        .task(id: query) { await load(reset: true) }
    }

    private func load(reset: Bool) async {
        if reset { loading = tracks.isEmpty }
        do {
            let text = query.trimmingCharacters(in: .whitespaces)
            if reset, !text.isEmpty {
                try await Task.sleep(for: .milliseconds(280))
                guard !Task.isCancelled else { return }
            }
            let page = try await client.tracks(
                limit: 200,
                offset: reset ? 0 : tracks.count,
                query: text.isEmpty ? nil : text
            )
            guard !Task.isCancelled else { return }
            tracks = reset ? page.items : tracks + page.items
            total = page.total
            message = nil
        } catch is CancellationError {
            return
        } catch {
            if reset { tracks = [] }
            message = MacErrorText.message(for: error)
        }
        loading = false
    }
}

struct MacSettingsView: View {
    let session: MacSession
    @AppStorage("menuBarPlayerEnabled") private var menuBarPlayerEnabled = true
    @AppStorage("desktopLyricsClickThrough") private var clickThrough = false
    @AppStorage("macPreferredBitrate") private var preferredBitrate = 0
    @AppStorage("lyricsWordHighlight") private var wordHighlight = true
    @AppStorage("lyricsShowTranslation") private var showTranslation = true
    @AppStorage("lyricsShowRomanization") private var showRomanization = false
    @AppStorage("macAppearance") private var appearance = "system"

    var body: some View {
        Form {
            Section("外观") {
                Picker("日夜模式", selection: $appearance) {
                    Text("跟随系统").tag("system")
                    Text("浅色").tag("light")
                    Text("深色").tag("dark")
                }
                .pickerStyle(.segmented)
                Text("同时应用于曲库、歌词和全屏播放页。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("播放") {
                Picker("播放音质", selection: $preferredBitrate) {
                    Text("原音").tag(0)
                    Text("AAC · 128 kbps").tag(128)
                    Text("AAC · 192 kbps").tag(192)
                    Text("AAC · 256 kbps").tag(256)
                    Text("AAC · 320 kbps").tag(320)
                }
                Text("切换音质从下次播放生效。AAC 档位用于无损音源，已有有损音源保持原音。")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("在菜单栏显示播放器", isOn: $menuBarPlayerEnabled)
            }
            Section("歌词") {
                Toggle("逐字高亮", isOn: $wordHighlight)
                Toggle("显示翻译", isOn: $showTranslation)
                Toggle("显示音译", isOn: $showRomanization)
                Text("逐字高亮需要歌词包含单字时间；普通歌词仍按行显示。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("桌面歌词") {
                Toggle("穿透点击", isOn: $clickThrough)
                Text("开启后鼠标可点击歌词下方的窗口；需要移动或关闭歌词时，请先关闭穿透。")
                    .font(.caption).foregroundStyle(.secondary)
                Button(session.desktopLyricsVisible ? "关闭桌面歌词" : "打开桌面歌词") {
                    NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
                }
            }
            Section("账号与服务器") {
                LabeledContent("账号", value: session.username)
                if let server = session.client?.server {
                    LabeledContent("服务器", value: server.description)
                    Link(destination: server.url) {
                        Label("打开网页版", systemImage: "arrow.up.right.square")
                    }
                }
                Text("账号资料、服务端连接和完整曲库管理可在网页版中设置。")
                    .font(.caption).foregroundStyle(.secondary)
                Button("退出登录", role: .destructive) {
                    Task { await session.logout() }
                }
            }
        }
        .formStyle(.grouped)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .navigationTitle("设置")
        .onChange(of: preferredBitrate) { _, value in
            session.playback?.preferredBitrateKbps = value == 0 ? nil : value
        }
    }
}
