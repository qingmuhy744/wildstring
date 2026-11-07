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
                        .id(client.server.description)
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
                .frame(width: 500)
                .interactiveDismissDisabled(session.isBusy)
        }
        .sheet(isPresented: Bindable(session).showRoutes) {
            if let routes = session.routes {
                MacServerRoutesSheet(session: session, routes: routes)
            }
        }
        .confirmationDialog("退出当前服务器？", isPresented: Bindable(session).confirmLogout, titleVisibility: .visible) {
            Button("退出服务器", role: .destructive) { Task { await session.logout() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("退出会停止当前播放。其他服务器的登录状态会保留。")
        }
        .confirmationDialog(
            "删除服务器「\(session.serverToDelete?.label ?? "")」？",
            isPresented: Binding(
                get: { session.serverToDelete != nil },
                set: { if !$0 { session.serverToDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("删除服务器", role: .destructive) {
                if let target = session.serverToDelete {
                    session.serverToDelete = nil
                    Task { await session.deleteServer(target) }
                }
            }
            Button("取消", role: .cancel) { session.serverToDelete = nil }
        } message: {
            Text("将清除该服务器在本机的登录凭据、保存的线路、播放队列与本地缓存。")
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

private struct MacServerRoutesSheet: View {
    let session: MacSession
    let routes: ServerRoutes

    private var aliasBinding: Binding<String> {
        Binding(
            get: { session.servers.first { $0.address == session.logicalServerAddress }?.alias ?? "" },
            set: { session.setServerAlias($0) }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("服务器与线路").font(.title2)
                Spacer()
                Button("完成") { session.showRoutes = false }
                    .keyboardShortcut(.defaultAction)
            }
            .padding([.horizontal, .top])
            .padding(.bottom, 6)

            TextField("本机别名（留空使用服务器名称）", text: aliasBinding)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal)
                .padding(.bottom, 6)

            ServerRoutesEditor(routes: routes)

            Divider().padding(.top, 8)

            HStack {
                Button("删除此服务器…", systemImage: "trash", role: .destructive) {
                    if let current = session.servers.first(where: { $0.address == session.logicalServerAddress }) {
                        session.showRoutes = false
                        session.serverToDelete = current
                    }
                }
                .buttonStyle(.bordered)
                .tint(.red)
                Spacer()
            }
            .padding()
        }
        .frame(width: 620)
        .frame(minHeight: 460, maxHeight: 680)
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
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 12) {
                Image("MenuBarIcon")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 28, height: 24)
                    .foregroundStyle(MacTheme.accent)
                    .frame(width: 48, height: 48)
                    .background(MacTheme.accentSoft, in: RoundedRectangle(cornerRadius: 14))
                VStack(alignment: .leading, spacing: 5) {
                    Text(addingServer ? "连接其他服务器" : "欢迎回到野弦")
                        .font(MacTheme.section(20))
                    Text(addingServer ? "登录后，即可在不同曲库间切换。" : "连接服务器，开始聆听你的音乐。")
                        .font(MacTheme.caption).foregroundStyle(MacTheme.muted)
                }
            }
            VStack(alignment: .leading, spacing: 18) {
                field("服务器地址", symbol: "server.rack") {
                    TextField("服务器地址", text: $serverText, prompt: Text(verbatim: "https://music.example.com"))
                        .textContentType(.URL)
                }
                field("用户名", symbol: "person") {
                    TextField("输入用户名", text: $username).textContentType(.username)
                }
                field("密码", symbol: "lock") {
                    SecureField("输入密码", text: $password).textContentType(.password)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Toggle("允许此服务器使用 HTTP", isOn: $allowInsecureHTTP)
                        .toggleStyle(.checkbox)
                    Text("用于局域网或 SD-WAN 的 HTTP 地址；公网建议使用 HTTPS。")
                        .font(MacTheme.caption).foregroundStyle(MacTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .disabled(session.isBusy)
            if let errorMessage = session.errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.circle")
                    .font(MacTheme.caption).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if session.routes != nil && !addingServer {
                Button("管理已保存线路 / 重新登录") { session.showRoutes = true }
            }
            if !session.servers.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("已保存的服务器").font(MacTheme.caption).foregroundStyle(MacTheme.muted)
                    ScrollView {
                        VStack(spacing: 6) {
                            ForEach(session.servers) { server in
                                HStack(spacing: 8) {
                                    Button {
                                        serverText = server.address
                                        username = server.username
                                        password = ""
                                        allowInsecureHTTP = server.allowInsecureHTTP
                                        Task { await session.switchServer(server) }
                                    } label: {
                                        HStack(spacing: 10) {
                                            Image(systemName: "server.rack").foregroundStyle(MacTheme.muted)
                                            VStack(alignment: .leading, spacing: 3) {
                                                Text(server.label).font(MacTheme.section(12)).lineLimit(1)
                                                Text(server.username).font(MacTheme.caption).foregroundStyle(MacTheme.muted)
                                            }
                                            Spacer()
                                            if session.logicalServerAddress == server.address {
                                                Text("当前连接").font(MacTheme.caption).foregroundStyle(MacTheme.muted)
                                            } else {
                                                Image(systemName: "arrow.right").foregroundStyle(MacTheme.accent)
                                            }
                                        }
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(session.isBusy || session.logicalServerAddress == server.address)

                                    Button {
                                        session.serverToDelete = server
                                    } label: {
                                        Image(systemName: "trash")
                                            .foregroundStyle(MacTheme.muted)
                                            .padding(4)
                                    }
                                    .buttonStyle(.plain)
                                    .help("删除服务器")
                                    .disabled(session.isBusy)
                                }
                                .padding(12)
                                .background(MacTheme.panel, in: RoundedRectangle(cornerRadius: 10))
                            }
                        }
                    }
                    .frame(height: CGFloat(min(session.servers.count, 3)) * 62)
                }
            }
            HStack(spacing: 12) {
                if session.isBusy { ProgressView().controlSize(.small) }
                Spacer()
                if addingServer {
                    Button("取消") { session.showServerLogin = false }
                        .keyboardShortcut(.cancelAction)
                        .disabled(session.isBusy)
                }
                Button(session.isBusy ? "正在连接…" : "连接服务器") {
                    Task {
                        await session.login(serverText: serverText, username: username, password: password,
                            allowInsecureHTTP: allowInsecureHTTP)
                        if session.errorMessage == nil { password = "" }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(session.isBusy || serverText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || username.isEmpty || password.isEmpty)
            }
            .controlSize(.large)
        }
        .font(MacTheme.body)
        .foregroundStyle(MacTheme.ink)
        .padding(28)
        .frame(width: 500)
        .background(MacTheme.canvas, in: RoundedRectangle(cornerRadius: 16))
        .frame(maxWidth: .infinity, maxHeight: addingServer ? nil : .infinity)
        .background(MacTheme.canvas)
    }

    private func field<Content: View>(_ title: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(MacTheme.caption).foregroundStyle(MacTheme.muted)
            HStack(spacing: 10) {
                Image(systemName: symbol).foregroundStyle(MacTheme.faint).frame(width: 16)
                content().textFieldStyle(.plain).accessibilityLabel(title)
            }
            .padding(12)
            .background(MacTheme.panel, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(MacTheme.border))
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
                .toolbar {
                    // Keep the native toolbar alive on pages without actions so
                    // switching pages does not move the window controls/content.
                    if #available(macOS 26.0, *) {
                        ToolbarItem(placement: .automatic) {
                            Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
                        }
                        .sharedBackgroundVisibility(.hidden)
                    } else {
                        ToolbarItem(placement: .automatic) {
                            Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
                        }
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
            MacTransportBar(session: session, client: client, playback: playback)
        }
        .background(MacTheme.canvas)
        .allowsHitTesting(!session.showFullscreen)
        .accessibilityHidden(session.showFullscreen)
        .toolbar(session.showFullscreen ? .hidden : .visible, for: .windowToolbar)
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
                Image("MenuBarIcon")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 22, height: 18)
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
                serverCard
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
                        Label("\(server.label) · \(server.username)",
                            systemImage: session.logicalServerAddress == server.address ? "checkmark.circle.fill" : "server.rack")
                    }
                    .disabled(session.logicalServerAddress == server.address)
                }
                Button("连接其他服务器…", systemImage: "plus") { session.addServer() }
            }
            Divider()
            Button("服务器名称与线路…", systemImage: "network") { session.showRoutes = true }
            Button("跨设备继续", systemImage: MacPage.devices.symbol) { session.page = .devices }
            Button("待确认草案", systemImage: MacPage.drafts.symbol) { session.page = .drafts }
            if session.canManage {
                Button("管理", systemImage: MacPage.manage.symbol) { session.page = .manage }
            }
            Divider()
            Button("退出当前服务器…", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                session.confirmLogout = true
            }
            Button("删除当前服务器…", systemImage: "trash", role: .destructive) {
                if let current = session.servers.first(where: { $0.address == session.logicalServerAddress }) {
                    session.serverToDelete = current
                }
            }
        } label: {
            Text(session.serverLabel)
                .font(MacTheme.section(12))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .overlay(alignment: .trailing) {
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 9))
                .foregroundStyle(sidebarFaint).allowsHitTesting(false)
        }
        .disabled(session.isBusy)
        .help("账号与服务器 · 点击切换服务器")
        .accessibilityLabel("账号与服务器")
    }

    private var serverCard: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "server.rack")
                .font(.system(size: 15)).foregroundStyle(sidebarMuted)
            VStack(alignment: .leading, spacing: 4) {
                serverMenu.foregroundStyle(sidebarInk)
                Text(session.username)
                    .font(MacTheme.micro).foregroundStyle(sidebarMuted).lineLimit(1)
                HStack(spacing: 5) {
                    Circle().fill(session.connection.map { connectionColor($0.status) } ?? sidebarFaint)
                        .frame(width: 7, height: 7)
                    Text(session.connection?.label ?? "连接中…")
                        .font(MacTheme.mono(10)).foregroundStyle(sidebarMuted)
                        .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                }
                .help(session.connection?.label ?? "连接中…")
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(sidebarAccentSoft.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .help("\(session.routes?.activeName ?? "默认线路") · \(session.connection?.label ?? "连接中…")")
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
