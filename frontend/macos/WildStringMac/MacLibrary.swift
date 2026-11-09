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
            emptyTitle: message == nil ? (query.isEmpty ? L10n("macLibrary.emptyLibrary") : L10n("macLibrary.noSearchResults", query)) : L10n("macLibrary.loadFailed"),
            emptyDetail: message,
            canManage: canManage,
            isLoading: loading
        )
        .navigationTitle(L10n("macLibrary.allTracksTitle"))
        .toolbar {
            TextField(L10n("macLibrary.searchPlaceholder"), text: $query)
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
                Button(L10n("macLibrary.moreTracksRemaining", total - tracks.count)) { Task { await load(reset: false) } }
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
    @AppStorage(InterfaceLanguage.storageKey) private var language = InterfaceLanguage.auto.rawValue

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L10n("macLibrary.settingsHeaderTitle"))
                            .font(MacTheme.display(28))
                        Text(L10n("macLibrary.settingsHeaderSubtitle"))
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
        .navigationTitle(L10n("macLibrary.settingsNavTitle"))
        .onChange(of: preferredBitrate) { _, value in
            session.playback?.preferredBitrateKbps = value == 0 ? nil : value
        }
    }

    private var appearanceCard: some View {
        card(L10n("macLibrary.cardAppearance"), symbol: "circle.lefthalf.filled") {
            Picker(L10n("macLibrary.appearanceMode"), selection: $appearance) {
                Text(L10n("macLibrary.themeSystem")).tag("system")
                Text(L10n("macLibrary.themeLight")).tag("light")
                Text(L10n("macLibrary.themeDark")).tag("dark")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityLabel(L10n("macLibrary.appearanceMode"))
            note(L10n("macLibrary.appearanceNote"))
            Divider()
            HStack {
                Text(L10n("settings.language"))
                Spacer(minLength: 12)
                Picker(L10n("settings.language"), selection: Binding(
                    get: { InterfaceLanguage(preference: language) },
                    set: { selected in
                        language = selected.rawValue
                        InterfaceLanguage.store(selected.rawValue)
                        if let client = session.client {
                            Task { _ = try? await client.updateLanguage(selected.rawValue) }
                        }
                    }
                )) {
                    ForEach(InterfaceLanguage.allCases, id: \.rawValue) { option in
                        Text(option.labelString).tag(option)
                    }
                }
                .labelsHidden()
                .frame(width: 164)
                .accessibilityLabel(L10n("settings.language"))
            }
        }
    }

    private var playbackCard: some View {
        card(L10n("macLibrary.cardPlayback"), symbol: "waveform") {
            HStack {
                Text(L10n("macLibrary.playbackQuality"))
                Spacer(minLength: 12)
                Picker(L10n("macLibrary.playbackQuality"), selection: $preferredBitrate) {
                    Text(L10n("macLibrary.qualityLossless")).tag(0)
                    Text("AAC · 128 kbps").tag(128)
                    Text("AAC · 192 kbps").tag(192)
                    Text("AAC · 256 kbps").tag(256)
                    Text("AAC · 320 kbps").tag(320)
                }
                .labelsHidden()
                .frame(width: 164)
                .accessibilityLabel(L10n("macLibrary.playbackQuality"))
            }
            note(L10n("macLibrary.playbackQualityNote"))
            Divider()
            settingToggle(L10n("macLibrary.showMenuBarPlayer"), isOn: $menuBarPlayerEnabled)
        }
    }

    private var lyricsCard: some View {
        card(L10n("macLibrary.cardLyrics"), symbol: "text.quote") {
            settingToggle(L10n("macLibrary.wordHighlight"), isOn: $wordHighlight)
            note(L10n("macLibrary.wordHighlightNote"))
            Divider()
            settingToggle(L10n("macLibrary.showTranslation"), isOn: $showTranslation)
            Divider()
            settingToggle(L10n("macLibrary.showRomanization"), isOn: $showRomanization)
        }
    }

    private var desktopLyricsCard: some View {
        card(L10n("macLibrary.cardDesktopLyrics"), symbol: "macwindow") {
            HStack {
                Text(session.desktopLyricsVisible ? L10n("macLibrary.desktopLyricsOpen") : L10n("macLibrary.showDesktopLyrics"))
                Spacer(minLength: 12)
                Button(session.desktopLyricsVisible ? L10n("macLibrary.closeDesktopLyrics") : L10n("macLibrary.openDesktopLyrics")) {
                    NotificationCenter.default.post(name: .wildstringShowDesktopLyrics, object: nil)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(session.desktopLyricsVisible ? L10n("macLibrary.closeDesktopLyricsAccessibility") : L10n("macLibrary.openDesktopLyricsAccessibility"))
            }
            Divider()
            settingToggle(L10n("macLibrary.clickThrough"), isOn: $clickThrough)
            note(L10n("macLibrary.clickThroughNote"))
        }
    }

    private var accountCard: some View {
        card(L10n("macLibrary.cardAccountServer"), symbol: "server.rack") {
            VStack(alignment: .leading, spacing: 6) {
                Text(session.serverLabel)
                    .font(MacTheme.section(18))
                    .lineLimit(2)
                    .textSelection(.enabled)
                Text(session.username)
                    .foregroundStyle(MacTheme.muted)
                    .textSelection(.enabled)
                Text("\(session.routes?.activeName ?? L10n("macLibrary.defaultRoute")) · \(session.connection?.label ?? L10n("macLibrary.connecting"))")
                    .font(MacTheme.caption)
                    .foregroundStyle(MacTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let server = session.client?.server {
                Link(destination: server.url) {
                    Label(L10n("macLibrary.openWeb"), systemImage: "arrow.up.right.square")
                }
                .help(server.description)
            }
            Divider()
            Button {
                session.showRoutes = true
            } label: {
                HStack {
                    Label(L10n("macLibrary.serverNameAndRoutes"), systemImage: "network")
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(session.isBusy || session.routes == nil)
            note(L10n("macLibrary.serverSettingsNote"))
            Divider()
            if session.servers.count > 1 {
                VStack(alignment: .leading, spacing: 8) {
                    Text(L10n("macLibrary.savedServers"))
                        .font(MacTheme.caption)
                        .foregroundStyle(MacTheme.muted)
                    ForEach(session.servers) { server in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(server.label)
                                        .font(MacTheme.section(13))
                                    if server.address == session.logicalServerAddress {
                                        Text(L10n("macLibrary.currentServerTag"))
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
                                Button(L10n("macLibrary.switchServer")) {
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
                            .help(L10n("macLibrary.deleteServerHelp"))
                        }
                        .padding(.vertical, 2)
                    }
                }
                Divider()
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    Button(L10n("macLibrary.connectOtherServer"), systemImage: "plus") { session.addServer() }
                        .buttonStyle(.bordered)
                    Spacer()
                    Button(L10n("macLibrary.logoutCurrentServer"), systemImage: "rectangle.portrait.and.arrow.right") {
                        session.confirmLogout = true
                    }
                    .buttonStyle(.bordered)
                    Button(L10n("macLibrary.deleteCurrentServer"), systemImage: "trash", role: .destructive) {
                        if let current = session.servers.first(where: { $0.address == session.logicalServerAddress }) {
                            session.serverToDelete = current
                        }
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Button(L10n("macLibrary.connectOtherServer"), systemImage: "plus") { session.addServer() }
                        .buttonStyle(.bordered)
                    HStack(spacing: 10) {
                        Button(L10n("macLibrary.logoutCurrentServer"), systemImage: "rectangle.portrait.and.arrow.right") {
                            session.confirmLogout = true
                        }
                        .buttonStyle(.bordered)
                        Button(L10n("macLibrary.deleteCurrentServer"), systemImage: "trash", role: .destructive) {
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
        card(L10n("macLibrary.cardSoftwareUpdate"), symbol: "arrow.triangle.2.circlepath") {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n("macLibrary.currentVersion", session.updater.currentVersion))
                        .font(MacTheme.section(14))
                    if let date = session.updater.lastCheckedAt {
                        Text(L10n("macLibrary.lastChecked", date.formatted(date: .numeric, time: .shortened)))
                            .font(MacTheme.caption)
                            .foregroundStyle(MacTheme.muted)
                    } else {
                        Text(L10n("macLibrary.neverChecked"))
                            .font(MacTheme.caption)
                            .foregroundStyle(MacTheme.muted)
                    }
                }
                Spacer(minLength: 12)
                Button(session.updater.phase == .checking ? L10n("macLibrary.checkingUpdates") : L10n("macLibrary.checkUpdates")) {
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
                        Text(L10n("macLibrary.newVersionFound", release.version))
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
                        Button(L10n("macLibrary.downloadDMG")) {
                            session.updater.openDownload(for: release)
                        }
                        .buttonStyle(.borderedProminent)

                        Button(L10n("macLibrary.viewReleaseNotes")) {
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
                        Text(L10n("macLibrary.upToDate"))
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
            settingToggle(L10n("macLibrary.autoCheckUpdates"), isOn: Binding(
                get: { session.updater.autoCheckEnabled },
                set: { session.updater.autoCheckEnabled = $0 }
            ))
            note(L10n("macLibrary.autoCheckUpdatesNote"))
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
