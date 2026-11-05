import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI

struct MacRootView: View {
    let session: MacSession
    @AppStorage("macAppearance") private var appearance = "system"
    @State private var systemDark = MacAppearance.isSystemDark()

    var body: some View {
        Group {
            switch session.phase {
            case .loading:
                ProgressView("正在连接…")
                    .frame(minWidth: 960, minHeight: 640)
            case .connect:
                MacLoginView(session: session)
            case .connected:
                if let client = session.client, let playback = session.playback {
                    MacShellView(session: session, client: client, playback: playback)
                        .id(client.server.origin)
                } else {
                    ProgressView()
                }
            }
        }
        .frame(minWidth: 1100, minHeight: 720)
        .tint(MacTheme.accent)
        .preferredColorScheme(MacAppearance.resolvedColorScheme(for: appearance, systemDark: systemDark))
        .onAppear {
            systemDark = MacAppearance.isSystemDark()
            MacAppearance.apply(appearance, systemDark: systemDark)
        }
        .onChange(of: appearance) { _, newValue in
            systemDark = MacAppearance.isSystemDark()
            MacAppearance.apply(newValue, systemDark: systemDark)
        }
        .onReceive(DistributedNotificationCenter.default().publisher(for: MacAppearance.notification)) { _ in
            systemDark = MacAppearance.isSystemDark()
            MacAppearance.apply(appearance, systemDark: systemDark)
        }
        .onReceive(NotificationCenter.default.publisher(for: .wildstringShowDesktopLyrics)) { _ in
            session.desktopLyrics.toggle(session: session)
        }
        .sheet(isPresented: Bindable(session).showServerLogin) {
            MacLoginView(session: session, addingServer: true)
                .frame(width: 520, height: 500)
                .interactiveDismissDisabled(session.isBusy)
        }
        .confirmationDialog("退出当前服务器？", isPresented: Bindable(session).confirmLogout, titleVisibility: .visible) {
            Button("退出服务器", role: .destructive) { Task { await session.logout() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("退出会停止当前播放。其他服务器的登录状态会保留。")
        }
        .alert("无法切换服务器", isPresented: Binding(
            get: { session.serverSwitchError != nil },
            set: { if !$0 { session.serverSwitchError = nil } }
        )) {
            Button("好", role: .cancel) { session.serverSwitchError = nil }
        } message: {
            Text(session.serverSwitchError ?? "")
        }
        .task { await session.restore() }
    }
}

private struct MacLoginView: View {
    let session: MacSession
    var addingServer = false
    @State private var serverText: String
    @State private var username: String
    @State private var password = ""
    @State private var allowInsecureHTTP: Bool

    init(session: MacSession, addingServer: Bool = false) {
        self.session = session
        self.addingServer = addingServer
        _serverText = State(initialValue: addingServer ? session.pendingServer?.address ?? "" : session.serverText)
        _username = State(initialValue: addingServer ? session.pendingServer?.username ?? "" : session.username)
        _allowInsecureHTTP = State(initialValue: addingServer ? session.pendingServer?.allowInsecureHTTP ?? false : session.allowInsecureHTTP)
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [MacTheme.accent.opacity(0.18), Color(nsColor: .windowBackgroundColor)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    Image(systemName: "waveform")
                        .font(.title2)
                        .foregroundStyle(MacTheme.accentDeep)
                        .frame(width: 44, height: 44)
                        .background(
                            MacTheme.accent.opacity(0.18),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                    VStack(alignment: .leading, spacing: 2) {
                        Text("野弦").font(.title2.bold())
                        Text(addingServer ? "连接另一个服务器" : "连接到你的曲库").font(.callout).foregroundStyle(.secondary)
                    }
                }
                TextField("服务器地址", text: $serverText)
                    .textFieldStyle(.roundedBorder)
                TextField("用户名", text: $username)
                    .textFieldStyle(.roundedBorder)
                SecureField("密码", text: $password)
                    .textFieldStyle(.roundedBorder)
                Toggle("允许未加密的 HTTP", isOn: $allowInsecureHTTP)
                if let errorMessage = session.errorMessage {
                    Text(errorMessage)
                        .font(.callout)
                        .foregroundStyle(.red)
                }
                HStack {
                    if addingServer {
                        Button("取消") { session.showServerLogin = false }
                            .keyboardShortcut(.cancelAction)
                            .disabled(session.isBusy)
                    }
                    Button(session.isBusy ? "正在连接…" : "连接") {
                        Task {
                            await session.login(serverText: serverText, username: username, password: password,
                                allowInsecureHTTP: allowInsecureHTTP)
                            if session.errorMessage == nil { password = "" }
                        }
                    }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(session.isBusy || serverText.isEmpty || username.isEmpty || password.isEmpty)
                }
                if !session.servers.isEmpty {
                    Text("最近的服务器")
                        .font(.headline)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(session.servers) { server in
                                Button("\(server.username) · \(server.address)") {
                                    serverText = server.address
                                    username = server.username
                                    password = ""
                                    allowInsecureHTTP = server.allowInsecureHTTP
                                    Task { await session.switchServer(server) }
                                }
                                .buttonStyle(.plain)
                                .disabled(session.isBusy || session.client?.server.description == server.address)
                            }
                        }
                    }
                    .frame(maxHeight: 100)
                }
            }
            .padding(28)
            .frame(width: 440)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }
}

private struct MacShellView: View {
    let session: MacSession
    let client: WildstringClient
    let playback: PlaybackService

    @State private var libraries: [MusicLibrary] = []
    @State private var navigationPath = NavigationPath()
    @Environment(\.colorScheme) private var colorScheme

    private var sidebarBackground: Color {
        colorScheme == .dark
            ? Color(red: 0x1C / 255, green: 0x1E / 255, blue: 0x18 / 255)
            : Color(red: 0xEE / 255, green: 0xEE / 255, blue: 0xE5 / 255)
    }
    private var sidebarInk: Color {
        colorScheme == .dark
            ? Color(red: 0xEE / 255, green: 0xEA / 255, blue: 0xE2 / 255)
            : Color(red: 0x2A / 255, green: 0x2B / 255, blue: 0x25 / 255)
    }
    private var sidebarMuted: Color {
        colorScheme == .dark
            ? Color(red: 0xA8 / 255, green: 0xA5 / 255, blue: 0x9C / 255)
            : Color(red: 0x62 / 255, green: 0x64 / 255, blue: 0x57 / 255)
    }
    private var sidebarFaint: Color {
        colorScheme == .dark
            ? Color(red: 0x8E / 255, green: 0x92 / 255, blue: 0x84 / 255)
            : Color(red: 0x8A / 255, green: 0x8E / 255, blue: 0x7D / 255)
    }
    private var sidebarAccent: Color {
        colorScheme == .dark
            ? Color(red: 0xE9 / 255, green: 0x8A / 255, blue: 0x6D / 255)
            : Color(red: 0x9F / 255, green: 0x42 / 255, blue: 0x2B / 255)
    }
    private var sidebarAccentSoft: Color {
        colorScheme == .dark
            ? Color(red: 0x30 / 255, green: 0x35 / 255, blue: 0x2A / 255)
            : Color(red: 0xDD / 255, green: 0xE2 / 255, blue: 0xD0 / 255)
    }
    private var sidebarBorder: Color {
        colorScheme == .dark
            ? Color(red: 0x33 / 255, green: 0x34 / 255, blue: 0x2E / 255)
            : Color(red: 0xDE / 255, green: 0xDE / 255, blue: 0xD2 / 255)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                sidebar
                Divider()
                NavigationStack(path: $navigationPath) {
                    page
                        .id(session.selectedLibraryID ?? "")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(MacTheme.canvas)
                        .navigationDestination(for: MacTrackDestination.self) { destination in
                            MacTrackCollectionView(client: client, playback: playback, favorites: session.favorites,
                                destination: destination, canManage: session.canManage)
                        }
                }
                .environment(\.navigateToTrackCollection) { navigationPath.append($0) }
                .onChange(of: session.page) { _, _ in navigationPath = NavigationPath() }
                .onChange(of: session.selectedLibraryID) { _, _ in navigationPath = NavigationPath() }
                if session.showLyrics || session.showQueue {
                    MacPlayerInspector(session: session, client: client, playback: playback)
                        .frame(width: 336)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(MacTheme.border))
                        .padding(12)
                }
            }
            Divider()
            MacTransportBar(session: session, client: client, playback: playback)
        }
        .background(MacTheme.canvas)
        .allowsHitTesting(!session.showFullscreen)
        .accessibilityHidden(session.showFullscreen)
        .toolbar(session.showFullscreen ? .hidden : .automatic, for: .windowToolbar)
        .toolbarBackground(.hidden, for: .windowToolbar)
        .task { libraries = (try? await client.libraries()) ?? [] }
        .onChange(of: playback.isPlaying) { _, playing in
            if playing { session.sync?.localPlaybackStarted() }
            Task { await session.sync?.publishCurrent() }
        }
        .overlay {
            if session.showFullscreen {
                Group {
                    if playback.currentItem?.trackID.hasPrefix("podcast_ep_") == true {
                        MacPodcastPlayer(session: session, client: client, playback: playback)
                    } else {
                        MacFullscreenPlayer(session: session, client: client, playback: playback)
                    }
                }
                    .ignoresSafeArea(.container, edges: .top)
            }
        }
        .overlay(alignment: .top) {
            if let offer = session.sync?.handoff {
                HStack(spacing: 12) {
                    Text("其他设备暂停在「\(offer.title)」")
                        .lineLimit(1)
                    Button("忽略") { session.sync?.dismiss() }
                    Button("继续") { Task { await session.sync?.accept() } }
                        .buttonStyle(.borderedProminent)
                }
                .padding(10)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(.top, 12)
            }
        }
    }

    @ViewBuilder
    private var page: some View {
        switch session.page {
        case .home:
            MacHomeView(session: session, client: client, playback: playback)
        case .search:
            MacSearchView(
                client: client,
                playback: playback,
                favorites: session.favorites,
                focusSearch: Bindable(session).focusLibrarySearch
            )
        case .tracks:
            MacMusicView(client: client, playback: playback, favorites: session.favorites,
                canManage: session.canManage, focusSearch: Bindable(session).focusLibrarySearch)
        case .albums:
            MacAlbumsView(client: client, playback: playback, favorites: session.favorites, canManage: session.canManage)
        case .artists:
            MacArtistsView(client: client, playback: playback, favorites: session.favorites, canManage: session.canManage)
        case .playlists:
            MacPlaylistsView(client: client, playback: playback, favorites: session.favorites, canManage: session.canManage)
        case .favorites:
            MacFavoritesView(client: client, playback: playback, favorites: session.favorites, canManage: session.canManage)
        case .discover:
            MacDiscoverView(client: client, playback: playback, favorites: session.favorites)
        case .podcasts:
            MacPodcastsView(client: client, playback: playback)
        case .assistant:
            if let assistant = session.assistant {
                MacAssistantView(model: assistant, playback: playback)
            }
        case .listening:
            MacListeningView(client: client, playback: playback, favorites: session.favorites, canManage: session.canManage)
        case .devices:
            MacDevicesView(sync: session.sync, playback: playback)
        case .notifications:
            MacNotificationsView(client: client)
        case .drafts:
            MacDraftsView(client: client, playback: playback)
        case .manage:
            MacManageView(client: client)
        case .settings:
            MacSettingsView(session: session)
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "waveform")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(sidebarAccent)
                    .frame(width: 32, height: 32)
                    .background(
                        sidebarAccentSoft,
                        in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                    )
                VStack(alignment: .leading, spacing: 1) {
                    Text("野弦")
                        .font(MacTheme.display(18))
                        .foregroundStyle(sidebarInk)
                    Text("个人声音档案")
                        .font(MacTheme.micro)
                        .foregroundStyle(sidebarFaint)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 14)
            Rectangle()
                .fill(sidebarBorder)
                .frame(height: 1)
                .padding(.horizontal, 14)
                .padding(.bottom, 6)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    sidebarRow(.home, badge: nil)
                    sidebarToggle(
                        title: MacPage.search.title,
                        symbol: MacPage.search.symbol,
                        selected: session.page == .search,
                        badge: nil
                    ) {
                        session.focusLibrarySearch = false
                        session.page = .search
                    }
                    group("我的音乐", pages: MacPage.library + [.listening])
                    group("发现", pages: MacPage.explore)
                    if libraries.filter(\.enabled).count > 1 {
                        Text("当前曲库")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 12)
                            .padding(.top, 16)
                        libraryButton("默认曲库", selected: session.selectedLibraryID == nil) {
                            session.selectLibrary(nil)
                        }
                        ForEach(libraries.filter(\.enabled)) { library in
                            libraryButton(library.name, selected: session.selectedLibraryID == library.id) {
                                session.selectLibrary(library.id)
                            }
                        }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 12)
            }
            Rectangle().fill(sidebarBorder).frame(height: 1)
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("工作区").font(MacTheme.micro).foregroundStyle(sidebarFaint)
                    Spacer()
                    footerButton(.notifications)
                    footerButton(.settings)
                }
                .padding(.horizontal, 8)
                serverMenu
            }
            .padding(14)
        }
        .frame(width: 228)
        .background(sidebarBackground)
    }

    private func connectionColor(_ status: MacConnectionMonitor.Status) -> Color {
        switch status {
        case .online: return MacTheme.olive
        case .slow: return MacTheme.accentDeep
        case .offline: return .red.opacity(0.9)
        case .checking: return sidebarFaint
        }
    }

    private var serverMenu: some View {
        Menu {
            Section("切换服务器") {
                ForEach(session.servers) { server in
                    Button {
                        Task { await session.switchServer(server) }
                    } label: {
                        Label("\(server.username) · \(server.address)",
                            systemImage: client.server.description == server.address ? "checkmark.circle.fill" : "server.rack")
                    }
                    .disabled(client.server.description == server.address)
                }
                Button("连接其他服务器…", systemImage: "plus") { session.addServer() }
            }
            Divider()
            Button("跨设备继续", systemImage: MacPage.devices.symbol) { session.page = .devices }
            Button("待确认草案", systemImage: MacPage.drafts.symbol) { session.page = .drafts }
            if session.canManage {
                Button("管理", systemImage: MacPage.manage.symbol) { session.page = .manage }
            }
            Divider()
            Button("退出当前服务器…", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                session.confirmLogout = true
            }
        } label: {
            HStack(spacing: 9) {
                Image(systemName: "server.rack")
                    .font(.system(size: 15)).foregroundStyle(sidebarMuted)
                VStack(alignment: .leading, spacing: 4) {
                    Text(client.server.url.host ?? "当前服务器")
                        .font(MacTheme.section(12)).foregroundStyle(sidebarInk).lineLimit(1)
                    HStack(spacing: 5) {
                        Circle().fill(session.connection.map { connectionColor($0.status) } ?? sidebarFaint)
                            .frame(width: 5, height: 5)
                        Text("\(session.username) · \(session.connection?.label ?? "连接中…")")
                            .font(MacTheme.micro).foregroundStyle(sidebarMuted).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9)).foregroundStyle(sidebarFaint)
            }
            .padding(10)
            .background(sidebarAccentSoft.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .disabled(session.isBusy)
        .help("账号与服务器 · 点击切换服务器")
        .accessibilityLabel("账号与服务器")
    }

    private func footerButton(_ page: MacPage) -> some View {
        Button { session.page = page } label: {
            Image(systemName: page.symbol)
                .font(.system(size: 14))
                .foregroundStyle(session.page == page ? sidebarAccent : sidebarMuted)
                .frame(width: 28, height: 28)
                .background(session.page == page ? sidebarAccentSoft : .clear,
                    in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .help(page.title)
        .accessibilityLabel(page.title)
    }

    private func group(_ title: String, pages: [MacPage]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(MacTheme.micro)
                .tracking(0.6)
                .foregroundStyle(sidebarFaint)
                .padding(.horizontal, 10)
                .padding(.top, 14)
                .padding(.bottom, 4)
            ForEach(pages) { page in
                sidebarRow(page, badge: badge(for: page))
            }
        }
    }

    private func badge(for page: MacPage) -> String? {
        guard page == .favorites, let count = session.favorites?.ids.count, count > 0 else { return nil }
        return "\(count)"
    }

    private func sidebarRow(_ page: MacPage, badge: String?) -> some View {
        sidebarToggle(title: page.title, symbol: page.symbol, selected: session.page == page, badge: badge) {
            session.page = page
        }
    }

    private func sidebarToggle(
        title: String,
        symbol: String,
        selected: Bool,
        badge: String?,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: symbol)
                        .font(.system(size: 13))
                        .frame(width: 18)
                        .foregroundStyle(selected ? sidebarAccent : sidebarMuted)
                    Text(title)
                        .font(.system(size: 13, weight: selected ? .semibold : .regular))
                        .foregroundStyle(selected ? sidebarAccent : sidebarInk)
                }
                Spacer(minLength: 4)
                if let badge {
                    Text(badge)
                        .font(MacTheme.mono(10))
                        .foregroundStyle(selected ? sidebarAccent : sidebarMuted)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(selected ? sidebarAccentSoft : Color.clear)
            )
            .overlay(alignment: .leading) {
                if selected {
                    Capsule()
                        .fill(sidebarAccent)
                        .frame(width: 3)
                        .padding(.vertical, 7)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func libraryButton(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.callout.weight(selected ? .semibold : .regular))
                .foregroundStyle(selected ? sidebarAccent : sidebarMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
        }
        .buttonStyle(.plain)
    }
}
