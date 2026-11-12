import AppKit
import CoreNetwork
import CorePlayback
import SwiftUI

struct MacRootView: View {
    let session: MacSession
    @AppStorage("macAppearance") private var appearance = "system"
    @AppStorage(InterfaceLanguage.storageKey) private var language = InterfaceLanguage.auto.rawValue
    @State private var systemDark = MacAppearance.isSystemDark()

    var body: some View {
        Group {
            switch session.phase {
            case .loading:
                ProgressView(L10n("macRoot.connecting"))
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
        .environment(\.locale, InterfaceLanguage(preference: language).locale)
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
        .confirmationDialog(L10n("macRoot.logoutConfirmTitle"), isPresented: Bindable(session).confirmLogout, titleVisibility: .visible) {
            Button(L10n("macRoot.logoutConfirmButton"), role: .destructive) { Task { await session.logout() } }
            Button(L10n("macRoot.cancel"), role: .cancel) {}
        } message: {
            Text(L10n("macRoot.logoutConfirmMessage"))
        }
        .confirmationDialog(
            L10n("macRoot.deleteServerConfirmTitle", session.serverToDelete?.label ?? ""),
            isPresented: Binding(
                get: { session.serverToDelete != nil },
                set: { if !$0 { session.serverToDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n("macRoot.deleteServerConfirmButton"), role: .destructive) {
                if let target = session.serverToDelete {
                    session.serverToDelete = nil
                    Task { await session.deleteServer(target) }
                }
            }
            Button(L10n("macRoot.cancel"), role: .cancel) { session.serverToDelete = nil }
        } message: {
            Text(L10n("macRoot.deleteServerConfirmMessage"))
        }
        .alert(L10n("macRoot.switchServerErrorTitle"), isPresented: Binding(
            get: { session.serverSwitchError != nil },
            set: { if !$0 { session.serverSwitchError = nil } }
        )) {
            Button(L10n("macRoot.ok"), role: .cancel) { session.serverSwitchError = nil }
        } message: {
            Text(session.serverSwitchError ?? "")
        }
        .alert(
            L10n("macRoot.updateAvailableTitle", session.updater.latestRelease?.version ?? ""),
            isPresented: Bindable(session.updater).showUpdateAlert
        ) {
            if let release = session.updater.latestRelease {
                Button(L10n("macRoot.downloadDMG")) {
                    session.updater.openDownload(for: release)
                }
                Button(L10n("macRoot.viewReleaseNotes")) {
                    session.updater.openReleasePage(for: release)
                }
            }
            Button(L10n("macRoot.later"), role: .cancel) {}
        } message: {
            if let notes = session.updater.latestRelease?.releaseNotes {
                Text(notes.prefix(300))
            } else {
                Text(L10n("macRoot.updateAvailableMessage"))
            }
        }
        .alert(L10n("macRoot.upToDateTitle"), isPresented: Bindable(session.updater).showUpToDateAlert) {
            Button(L10n("macRoot.ok"), role: .cancel) {}
        } message: {
            Text(L10n("macRoot.upToDateMessage", session.updater.currentVersion))
        }
        .alert(L10n("macRoot.updateCheckFailedTitle"), isPresented: Bindable(session.updater).showErrorAlert) {
            Button(L10n("macRoot.ok"), role: .cancel) {}
        } message: {
            Text(session.updater.errorMessage ?? L10n("macRoot.updateCheckFailedDefaultMessage"))
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
                Text(L10n("macRoot.serverAndRoutesTitle")).font(.title2)
                Spacer()
                Button(L10n("macRoot.done")) { session.showRoutes = false }
                    .keyboardShortcut(.defaultAction)
            }
            .padding([.horizontal, .top])
            .padding(.bottom, 6)

            TextField(L10n("macRoot.localAliasPrompt"), text: aliasBinding)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal)
                .padding(.bottom, 6)

            ServerRoutesEditor(routes: routes)

            Divider().padding(.top, 8)

            HStack {
                Button(L10n("macRoot.deleteServerButton"), systemImage: "trash", role: .destructive) {
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
                    Text(addingServer ? L10n("macRoot.loginTitleAddServer") : L10n("macRoot.loginTitleWelcome"))
                        .font(MacTheme.section(20))
                    Text(addingServer ? L10n("macRoot.loginSubtitleAddServer") : L10n("macRoot.loginSubtitleWelcome"))
                        .font(MacTheme.caption).foregroundStyle(MacTheme.muted)
                }
            }
            VStack(alignment: .leading, spacing: 18) {
                field(L10n("macRoot.fieldServerAddress"), symbol: "server.rack") {
                    TextField(L10n("macRoot.fieldServerAddress"), text: $serverText, prompt: Text(verbatim: "https://music.example.com"))
                        .textContentType(.URL)
                }
                field(L10n("macRoot.fieldUsername"), symbol: "person") {
                    TextField(L10n("macRoot.fieldUsernamePrompt"), text: $username).textContentType(.username)
                }
                field(L10n("macRoot.fieldPassword"), symbol: "lock") {
                    SecureField(L10n("macRoot.fieldPasswordPrompt"), text: $password).textContentType(.password)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Toggle(L10n("macRoot.allowInsecureHttp"), isOn: $allowInsecureHTTP)
                        .toggleStyle(.checkbox)
                    Text(L10n("macRoot.allowInsecureHttpNote"))
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
                Button(L10n("macRoot.manageRoutesOrReauth")) { session.showRoutes = true }
            }
            if !session.servers.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(L10n("macRoot.savedServers")).font(MacTheme.caption).foregroundStyle(MacTheme.muted)
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
                                                Text(L10n("macRoot.currentConnection")).font(MacTheme.caption).foregroundStyle(MacTheme.muted)
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
                                    .help(L10n("macRoot.deleteServerHelp"))
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
                    Button(L10n("macRoot.cancel")) { session.showServerLogin = false }
                        .keyboardShortcut(.cancelAction)
                        .disabled(session.isBusy)
                }
                Button(session.isBusy ? L10n("macRoot.connecting") : L10n("macRoot.connectServerButton")) {
                    Task {
                        await session.login(serverText: serverText, username: username, password: password,
                            allowInsecureHTTP: allowInsecureHTTP)
                        if session.errorMessage == nil { password = "" }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .tint(MacTheme.accentDeep)
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

    // Alias MacTheme tokens; the sidebar owns no colours of its own except faint.
    private var sidebarBackground: Color { MacTheme.sidebar }
    private var sidebarInk: Color { MacTheme.ink }
    private var sidebarMuted: Color { MacTheme.muted }
    private var sidebarFaint: Color {
        colorScheme == .dark
            ? Color(red: 0x9A / 255, green: 0x94 / 255, blue: 0x8A / 255)
            : Color(red: 0x8A / 255, green: 0x8E / 255, blue: 0x7D / 255)
    }
    private var sidebarAccent: Color { MacTheme.accentDeep }
    private var sidebarAccentSoft: Color { MacTheme.oliveSoft }
    private var sidebarBorder: Color { MacTheme.border }

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
                    Text(L10n("macRoot.handoffPausedAt", offer.title))
                        .lineLimit(1)
                    Button(L10n("macRoot.handoffDismiss")) { session.sync?.dismiss() }
                    Button(L10n("macRoot.handoffResume")) { Task { await session.sync?.accept() } }
                        .buttonStyle(.borderedProminent)
                        .tint(MacTheme.accentDeep)
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
            MacPodcastsView(client: client, playback: playback, favorites: session.favorites)
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
                Text(L10n("macRoot.brandName"))
                    .font(MacTheme.display(18))
                    .foregroundStyle(sidebarInk)
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
                    group(L10n("macRoot.groupMyMusic"), pages: MacPage.library + [.listening])
                    group(L10n("macRoot.groupExplore"), pages: MacPage.explore)
                    if libraries.filter(\.enabled).count > 1 {
                        Text(L10n("macRoot.currentLibrary"))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 12)
                            .padding(.top, 16)
                        libraryButton(L10n("macRoot.defaultLibrary"), selected: session.selectedLibraryID == nil) {
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
                    Text(L10n("macRoot.workspaceSection")).font(MacTheme.micro).foregroundStyle(sidebarFaint)
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
        case .online: return MacTheme.success
        case .slow: return MacTheme.accentDeep
        case .offline: return .red.opacity(0.9)
        case .checking: return sidebarFaint
        }
    }

    private var serverMenu: some View {
        Menu {
            Section(L10n("macRoot.menuSwitchServer")) {
                ForEach(session.servers) { server in
                    Button {
                        Task { await session.switchServer(server) }
                    } label: {
                        Label("\(server.label) · \(server.username)",
                            systemImage: session.logicalServerAddress == server.address ? "checkmark.circle.fill" : "server.rack")
                    }
                    .disabled(session.logicalServerAddress == server.address)
                }
                Button(L10n("macRoot.connectOtherServer"), systemImage: "plus") { session.addServer() }
            }
            Divider()
            Button(L10n("macRoot.serverNameAndRoutes"), systemImage: "network") { session.showRoutes = true }
            Button(L10n("macRoot.devicesPage"), systemImage: MacPage.devices.symbol) { session.page = .devices }
            Button(L10n("macRoot.draftsPage"), systemImage: MacPage.drafts.symbol) { session.page = .drafts }
            if session.canManage {
                Button(L10n("macRoot.managePage"), systemImage: MacPage.manage.symbol) { session.page = .manage }
            }
            Divider()
            Button(L10n("macRoot.logoutCurrentServer"), systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                session.confirmLogout = true
            }
            Button(L10n("macRoot.deleteCurrentServer"), systemImage: "trash", role: .destructive) {
                if let current = session.servers.first(where: { $0.address == session.logicalServerAddress }) {
                    session.serverToDelete = current
                }
            }
        } label: {
            // Explicit label colours: the system menu styles tint text with the accent colour.
            HStack(spacing: 6) {
                Text(session.serverLabel)
                    .font(MacTheme.section(12))
                    .foregroundStyle(sidebarInk)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9))
                    .foregroundStyle(sidebarFaint)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .disabled(session.isBusy)
        .help(L10n("macRoot.serverMenuHelp"))
        .accessibilityLabel(L10n("macRoot.serverMenuAccessibility"))
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
                    Text(session.connection?.label ?? L10n("macRoot.connecting"))
                        .font(MacTheme.mono(10)).foregroundStyle(sidebarMuted)
                        .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                }
                .help(session.connection?.label ?? L10n("macRoot.connecting"))
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(sidebarAccentSoft.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .help("\(session.routes?.activeName ?? L10n("macRoot.defaultRoute")) · \(session.connection?.label ?? L10n("macRoot.connecting"))")
    }

    private func footerButton(_ page: MacPage) -> some View {
        Button { session.page = page } label: {
            Image(systemName: page.symbol)
                .font(.system(size: 14))
                .foregroundStyle(session.page == page ? sidebarAccent : sidebarMuted)
                .frame(width: 28, height: 28)
                .background(session.page == page ? sidebarAccentSoft : .clear,
                    in: RoundedRectangle(cornerRadius: 8))
                .overlay(alignment: .topTrailing) {
                    if page == .settings, case .available = session.updater.phase {
                        Circle()
                            .fill(sidebarAccent)
                            .frame(width: 6, height: 6)
                            .offset(x: -2, y: 2)
                    }
                }
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
