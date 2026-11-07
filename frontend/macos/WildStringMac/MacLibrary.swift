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
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("让野弦更合你的习惯")
                            .font(MacTheme.display(28))
                        Text("调整外观、聆听体验与服务器连接。")
                            .font(MacTheme.body)
                            .foregroundStyle(MacTheme.muted)
                    }

                    let layout = geometry.size.width >= 860
                        ? AnyLayout(HStackLayout(alignment: .top, spacing: 20))
                        : AnyLayout(VStackLayout(spacing: 20))
                    layout {
                        VStack(spacing: 20) {
                            appearanceCard
                            playbackCard
                            desktopLyricsCard
                        }
                        .frame(maxWidth: .infinity)
                        VStack(spacing: 20) {
                            lyricsCard
                            accountCard
                            softwareUpdateCard
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
                .frame(maxWidth: 1120, alignment: .leading)
                .padding(geometry.size.width >= 860 ? 32 : 24)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .background(MacTheme.canvas)
        .foregroundStyle(MacTheme.ink)
        .tint(MacTheme.accent)
        .font(MacTheme.body)
        .toggleStyle(.switch)
        .navigationTitle("设置")
        .onChange(of: preferredBitrate) { _, value in
            session.playback?.preferredBitrateKbps = value == 0 ? nil : value
        }
    }

    private var appearanceCard: some View {
        card("外观", symbol: "circle.lefthalf.filled") {
            Picker("日夜模式", selection: $appearance) {
                Text("跟随系统").tag("system")
                Text("浅色").tag("light")
                Text("深色").tag("dark")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityLabel("日夜模式")
            note("同时应用于曲库、歌词和全屏播放页。")
        }
    }

    private var playbackCard: some View {
        card("播放", symbol: "waveform") {
            HStack {
                Text("播放音质")
                Spacer(minLength: 12)
                Picker("播放音质", selection: $preferredBitrate) {
                    Text("原音").tag(0)
                    Text("AAC · 128 kbps").tag(128)
                    Text("AAC · 192 kbps").tag(192)
                    Text("AAC · 256 kbps").tag(256)
                    Text("AAC · 320 kbps").tag(320)
                }
                .labelsHidden()
                .frame(width: 164)
                .accessibilityLabel("播放音质")
            }
            note("音质切换从下次播放生效。AAC 适用于无损音源，已有有损音源保持原音。")
            Divider()
            settingToggle("在菜单栏显示播放器", isOn: $menuBarPlayerEnabled)
        }
    }

    private var lyricsCard: some View {
        card("歌词", symbol: "text.quote") {
            settingToggle("逐字高亮", isOn: $wordHighlight)
            note("歌词包含单字时间时逐字高亮，普通歌词仍按行显示。")
            Divider()
            settingToggle("显示翻译", isOn: $showTranslation)
            Divider()
            settingToggle("显示音译", isOn: $showRomanization)
        }
    }

    private var desktopLyricsCard: some View {
        card("桌面歌词", symbol: "macwindow") {
            HStack {
                Text(session.desktopLyricsVisible ? "桌面歌词已打开" : "在桌面上显示歌词")
                Spacer(minLength: 12)
                Button(session.desktopLyricsVisible ? "关闭" : "打开") {
                    NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(session.desktopLyricsVisible ? "关闭桌面歌词" : "打开桌面歌词")
            }
            Divider()
            settingToggle("穿透点击", isOn: $clickThrough)
            note("开启后可点击歌词下方的窗口。移动或关闭歌词前，请先关闭穿透。")
        }
    }

    private var accountCard: some View {
        card("账号与服务器", symbol: "server.rack") {
            VStack(alignment: .leading, spacing: 6) {
                Text(session.serverLabel)
                    .font(MacTheme.section(18))
                    .lineLimit(2)
                    .textSelection(.enabled)
                Text(session.username)
                    .foregroundStyle(MacTheme.muted)
                    .textSelection(.enabled)
                Text("\(session.routes?.activeName ?? "默认线路") · \(session.connection?.label ?? "连接中…")")
                    .font(MacTheme.caption)
                    .foregroundStyle(MacTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let server = session.client?.server {
                Link(destination: server.url) {
                    Label("打开网页版", systemImage: "arrow.up.right.square")
                }
                .help(server.description)
            }
            Divider()
            Button {
                session.showRoutes = true
            } label: {
                HStack {
                    Label("服务器名称与线路", systemImage: "network")
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(session.isBusy || session.routes == nil)
            note("为这台服务器设置本机别名，管理线路与切换方式。账号资料和曲库管理请前往网页版。")
            Divider()
            if session.servers.count > 1 {
                VStack(alignment: .leading, spacing: 8) {
                    Text("已保存的服务器")
                        .font(MacTheme.caption)
                        .foregroundStyle(MacTheme.muted)
                    ForEach(session.servers) { server in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(server.label)
                                        .font(MacTheme.section(13))
                                    if server.address == session.logicalServerAddress {
                                        Text("当前")
                                            .font(MacTheme.caption)
                                            .foregroundStyle(MacTheme.accent)
                                    }
                                }
                                Text("\(server.username) · \(server.address)")
                                    .font(MacTheme.caption)
                                    .foregroundStyle(MacTheme.muted)
                            }
                            Spacer()
                            if server.address != session.logicalServerAddress {
                                Button("切换") {
                                    Task { await session.switchServer(server) }
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                            Button {
                                session.serverToDelete = server
                            } label: {
                                Image(systemName: "trash")
                                    .foregroundStyle(MacTheme.muted)
                            }
                            .buttonStyle(.plain)
                            .help("删除服务器")
                        }
                        .padding(.vertical, 2)
                    }
                }
                Divider()
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    Button("连接其他服务器…", systemImage: "plus") { session.addServer() }
                        .buttonStyle(.bordered)
                    Spacer()
                    Button("退出当前服务器…", systemImage: "rectangle.portrait.and.arrow.right") {
                        session.confirmLogout = true
                    }
                    .buttonStyle(.bordered)
                    Button("删除当前服务器…", systemImage: "trash", role: .destructive) {
                        if let current = session.servers.first(where: { $0.address == session.logicalServerAddress }) {
                            session.serverToDelete = current
                        }
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Button("连接其他服务器…", systemImage: "plus") { session.addServer() }
                        .buttonStyle(.bordered)
                    HStack(spacing: 10) {
                        Button("退出当前服务器…", systemImage: "rectangle.portrait.and.arrow.right") {
                            session.confirmLogout = true
                        }
                        .buttonStyle(.bordered)
                        Button("删除当前服务器…", systemImage: "trash", role: .destructive) {
                            if let current = session.servers.first(where: { $0.address == session.logicalServerAddress }) {
                                session.serverToDelete = current
                            }
                        }
                        .buttonStyle(.bordered)
                        .tint(.red)
                    }
                }
            }
            .disabled(session.isBusy)
        }
    }

    private var softwareUpdateCard: some View {
        card("软件更新", symbol: "arrow.triangle.2.circlepath") {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("当前版本：v\(session.updater.currentVersion)")
                        .font(MacTheme.section(14))
                    if let date = session.updater.lastCheckedAt {
                        Text("上次检查：\(date.formatted(date: .numeric, time: .shortened))")
                            .font(MacTheme.caption)
                            .foregroundStyle(MacTheme.muted)
                    } else {
                        Text("尚未检查更新")
                            .font(MacTheme.caption)
                            .foregroundStyle(MacTheme.muted)
                    }
                }
                Spacer(minLength: 12)
                Button(session.updater.phase == .checking ? "正在检查…" : "检查更新") {
                    Task { await session.updater.checkForUpdates(manual: true) }
                }
                .buttonStyle(.bordered)
                .disabled(session.updater.phase == .checking)
            }

            switch session.updater.phase {
            case .available(let release):
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .foregroundStyle(MacTheme.accent)
                        Text("发现新版本 v\(release.version)")
                            .font(MacTheme.section(14))
                            .foregroundStyle(MacTheme.accent)
                    }
                    if !release.releaseNotes.isEmpty {
                        Text(release.releaseNotes)
                            .font(MacTheme.caption)
                            .foregroundStyle(MacTheme.ink)
                            .lineLimit(4)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(MacTheme.panel, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    HStack(spacing: 10) {
                        Button("下载更新 (DMG)") {
                            session.updater.openDownload(for: release)
                        }
                        .buttonStyle(.borderedProminent)

                        Button("查看发布说明 ↗") {
                            session.updater.openReleasePage(for: release)
                        }
                        .buttonStyle(.plain)
                        .font(MacTheme.caption)
                        .foregroundStyle(MacTheme.accent)
                    }
                }
                .padding(.top, 4)

            case .upToDate:
                if session.updater.showManualFeedback {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Text("当前已是最新版本")
                            .font(MacTheme.caption)
                            .foregroundStyle(MacTheme.muted)
                    }
                }

            case .error(let message):
                if session.updater.showManualFeedback {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text(message)
                            .font(MacTheme.caption)
                            .foregroundStyle(.orange)
                    }
                }

            case .idle, .checking:
                EmptyView()
            }

            Divider()
            settingToggle("自动检查更新", isOn: Binding(
                get: { session.updater.autoCheckEnabled },
                set: { session.updater.autoCheckEnabled = $0 }
            ))
            note("开启后将在后台静默检测新版本；发现新版本时在设置与菜单中提示。")
        }
    }

    private func card<Content: View>(
        _ title: String,
        symbol: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label {
                Text(title).font(MacTheme.section())
            } icon: {
                Image(systemName: symbol)
                    .foregroundStyle(MacTheme.accent)
                    .frame(width: 20)
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .macPanel(padding: 20)
    }

    private func settingToggle(_ title: String, isOn: Binding<Bool>) -> some View {
        HStack {
            Text(title)
            Spacer(minLength: 12)
            Toggle(title, isOn: isOn).labelsHidden().accessibilityLabel(title)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(MacTheme.caption)
            .foregroundStyle(MacTheme.muted)
            .fixedSize(horizontal: false, vertical: true)
    }
}
