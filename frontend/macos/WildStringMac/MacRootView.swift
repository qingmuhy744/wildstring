import CoreNetwork
import CorePlayback
import SwiftUI

struct MacRootView: View {
    let session: MacSession
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @AppStorage("macAppearance") private var appearance = "system"

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
        .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
        .onReceive(NotificationCenter.default.publisher(for: .wildstringShowDesktopLyrics)) { _ in
            if session.desktopLyricsVisible {
                dismissWindow(id: "desktop-lyrics")
                session.desktopLyricsVisible = false
            } else {
                openWindow(id: "desktop-lyrics")
                session.desktopLyricsVisible = true
            }
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

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                sidebar
                Divider()
                NavigationStack(path: $navigationPath) {
                    page
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .navigationDestination(for: MacTrackDestination.self) { destination in
                            MacTrackCollectionView(client: client, playback: playback, favorites: session.favorites,
                                destination: destination, canManage: session.canManage)
                        }
                }
                .environment(\.navigateToTrackCollection) { navigationPath.append($0) }
                .id("\(session.page.rawValue)|\(session.selectedLibraryID ?? "")")
                .onChange(of: session.page) { _, _ in navigationPath = NavigationPath() }
                .onChange(of: session.selectedLibraryID) { _, _ in navigationPath = NavigationPath() }
                if session.showLyrics || session.showQueue {
                    Divider()
                    MacPlayerInspector(session: session, client: client, playback: playback)
                        .frame(width: 400)
                }
            }
            Divider()
            MacTransportBar(session: session, client: client, playback: playback)
        }
        .background(Color(nsColor: .windowBackgroundColor))
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
            HStack(spacing: 8) {
                Image(systemName: "waveform")
                    .foregroundStyle(MacTheme.accentDeep)
                Text("野弦")
                    .font(.title3.bold())
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
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
            Divider()
            VStack(alignment: .leading, spacing: 2) {
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
                .foregroundStyle(.secondary)
            }
            .padding(10)
        }
        .frame(width: 232)
        .background(.ultraThinMaterial)
    }

    private func group(_ title: String, pages: [MacPage]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
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
                Label(title, systemImage: symbol)
                    .font(.body.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? MacTheme.accentDeep : Color.primary)
                Spacer(minLength: 4)
                if let badge {
                    Text(badge)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(selected ? MacTheme.accentDeep : Color.secondary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(selected ? MacTheme.accent.opacity(0.18) : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func libraryButton(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.callout.weight(selected ? .semibold : .regular))
                .foregroundStyle(selected ? MacTheme.accentDeep : Color.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
        }
        .buttonStyle(.plain)
    }
}
