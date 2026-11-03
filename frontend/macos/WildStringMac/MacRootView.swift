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
        .task { await session.restore() }
    }
}

private struct MacLoginView: View {
    let session: MacSession

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
                        Text("连接到你的曲库").font(.callout).foregroundStyle(.secondary)
                    }
                }
                TextField("服务器地址", text: Bindable(session).serverText)
                    .textFieldStyle(.roundedBorder)
                TextField("用户名", text: Bindable(session).username)
                    .textFieldStyle(.roundedBorder)
                SecureField("密码", text: Bindable(session).password)
                    .textFieldStyle(.roundedBorder)
                Toggle("允许未加密的 HTTP", isOn: Bindable(session).allowInsecureHTTP)
                if let errorMessage = session.errorMessage {
                    Text(errorMessage)
                        .font(.callout)
                        .foregroundStyle(.red)
                }
                Button(session.isBusy ? "正在连接…" : "连接") {
                    Task { await session.login() }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(
                    session.isBusy || session.serverText.isEmpty || session.username.isEmpty
                        || session.password.isEmpty
                )
                if !session.servers.isEmpty {
                    Text("最近的服务器")
                        .font(.headline)
                    ForEach(session.servers) { server in
                        Button("\(server.username) · \(server.address)") {
                            session.serverText = server.address
                            session.username = server.username
                            session.allowInsecureHTTP = server.allowInsecureHTTP
                        }
                        .buttonStyle(.plain)
                    }
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
    @AppStorage("macAppearance") private var appearance = "system"

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
                        .toolbar {
                            ToolbarItem(placement: .automatic) {
                                Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
                            }
                        }
                        .navigationDestination(for: MacTrackDestination.self) { destination in
                            MacTrackCollectionView(client: client, playback: playback, favorites: session.favorites,
                                destination: destination, canManage: session.canManage)
                        }
                }
                .environment(\.navigateToTrackCollection) { navigationPath.append($0) }
                .onChange(of: session.page) { _, _ in navigationPath = NavigationPath() }
                .onChange(of: session.selectedLibraryID) { _, _ in navigationPath = NavigationPath() }
                if session.showLyrics || session.showQueue {
                    Rectangle().fill(MacTheme.border).frame(width: 1)
                    MacPlayerInspector(session: session, client: client, playback: playback)
                        .frame(width: 336)
                }
            }
            Divider()
            MacTransportBar(session: session, client: client, playback: playback)
        }
        .background(MacTheme.canvas)
        .allowsHitTesting(!session.showFullscreen)
        .accessibilityHidden(session.showFullscreen)
        .toolbar(session.showFullscreen ? .hidden : .automatic, for: .windowToolbar)
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
                    group("曲库", pages: MacPage.library)
                    group("发现与电台", pages: MacPage.explore)
                    sidebarToggle(
                        title: "播放队列",
                        symbol: "list.number",
                        selected: session.showQueue,
                        badge: playback.items.isEmpty ? nil : "\(playback.items.count)"
                    ) {
                        session.showQueue.toggle()
                    }
                    .padding(.top, 8)
                    group("更多音乐", pages: MacPage.more)
                    group("助手工具", pages: MacPage.tools)
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
            VStack(alignment: .leading, spacing: 2) {
                if let connection = session.connection {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(connectionColor(connection.status))
                            .frame(width: 7, height: 7)
                        Text(connection.label)
                            .font(MacTheme.micro)
                            .foregroundStyle(sidebarMuted)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
                    .help("每 10 秒检测一次服务器连通性")
                }
                appearancePicker
                if session.canManage {
                    sidebarRow(.manage, badge: nil)
                }
                sidebarRow(.settings, badge: nil)
                Button {
                    Task { await session.logout() }
                } label: {
                    Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .font(.system(size: 12))
                .foregroundStyle(sidebarMuted)
            }
            .padding(10)
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

    private var appearancePicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("外观")
                .font(MacTheme.micro)
                .foregroundStyle(sidebarFaint)
                .padding(.horizontal, 10)
            Picker("外观", selection: $appearance) {
                Text("自动").tag("system")
                Text("浅色").tag("light")
                Text("深色").tag("dark")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 10)
        }
        .padding(.bottom, 4)
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
