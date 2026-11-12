import AppKit
import CoreNetwork
import SwiftUI

enum MacAppearance {
    static let notification = Notification.Name("AppleInterfaceThemeChangedNotification")

    static func isSystemDark() -> Bool {
        if let style = CFPreferencesCopyValue(
            "AppleInterfaceStyle" as CFString,
            kCFPreferencesAnyApplication,
            kCFPreferencesCurrentUser,
            kCFPreferencesAnyHost
        ) as? String {
            return style.lowercased() == "dark"
        }
        return false
    }

    static func resolvedColorScheme(
        for setting: String,
        systemDark: Bool = isSystemDark()
    ) -> ColorScheme {
        switch setting {
        case "light": return .light
        case "dark": return .dark
        default: return systemDark ? .dark : .light
        }
    }

    static func nsAppearance(
        for setting: String,
        systemDark: Bool = isSystemDark()
    ) -> NSAppearance? {
        let scheme = resolvedColorScheme(for: setting, systemDark: systemDark)
        return NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
    }

    @MainActor
    static func apply(_ setting: String, systemDark: Bool = isSystemDark()) {
        let target = nsAppearance(for: setting, systemDark: systemDark)
        NSApplication.shared.appearance = target
        for window in NSApplication.shared.windows {
            window.appearance = target
            window.contentView?.appearance = target
            window.contentView?.needsDisplay = true
        }
    }
}

enum MacTheme {
    /// Warm editorial palette aligned with the Web light/dark theme tokens.
    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let value = appearance.name.rawValue.lowercased().contains("dark") ? dark : light
            return NSColor(
                srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
                green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255,
                alpha: 1
            )
        })
    }

    static let canvas = adaptive(light: 0xF6F3ED, dark: 0x181614)
    static let sidebar = adaptive(light: 0xEEEEE5, dark: 0x1D1A18)
    static let panel = adaptive(light: 0xFAF9F4, dark: 0x211E1B)
    static let raised = adaptive(light: 0xFFFDF8, dark: 0x2A2622)
    static let border = adaptive(light: 0xDEDED2, dark: 0x3A352F)
    static let ink = adaptive(light: 0x2A2B25, dark: 0xE8E3D9)
    static let muted = adaptive(light: 0x626457, dark: 0xAAA59A)
    static let faint = adaptive(light: 0x6A6E5B, dark: 0x9A948A)
    static let accent = adaptive(light: 0xBC5438, dark: 0xE98A6D)
    static let accentDeep = adaptive(light: 0x9F422B, dark: 0xE98A6D)
    static let accentSoft = adaptive(light: 0xDDE2D0, dark: 0x2B2521)
    static let olive = adaptive(light: 0x57492F, dark: 0xB4C09E)
    static let oliveSoft = adaptive(light: 0xE4E7DB, dark: 0x2E2924)
    static let success = adaptive(light: 0x496332, dark: 0xB2C69A)
    static let warning = adaptive(light: 0x80591E, dark: 0xE5BD7C)
    static let danger = adaptive(light: 0xA64027, dark: 0xF2A392)
    static let hover = adaptive(light: 0xE4E7DB, dark: 0x34302A)
    static let onAccent = adaptive(light: 0xFFFAF3, dark: 0x211B17)

    static let cardRadius: CGFloat = 14
    static let panelRadius: CGFloat = 16
    static let rowRadius: CGFloat = 10

    static func display(_ size: CGFloat) -> Font {
        .system(size: size, weight: .medium, design: .serif)
    }

    static func section(_ size: CGFloat = 15) -> Font {
        .system(size: size, weight: .semibold)
    }

    static let body = Font.system(size: 13)
    static let caption = Font.system(size: 12)
    static let micro = Font.system(size: 10, weight: .semibold)

    static func mono(_ size: CGFloat = 11) -> Font {
        .system(size: size, weight: .medium, design: .monospaced).monospacedDigit()
    }
}

private struct MacPanelModifier: ViewModifier {
    var padding: CGFloat = 16
    var radius: CGFloat = MacTheme.cardRadius
    var fill: Color = MacTheme.panel

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(MacTheme.border, lineWidth: 1)
            )
    }
}

extension View {
    func macPanel(
        padding: CGFloat = 16,
        radius: CGFloat = MacTheme.cardRadius,
        fill: Color = MacTheme.panel
    ) -> some View {
        modifier(MacPanelModifier(padding: padding, radius: radius, fill: fill))
    }
}

/// House search input: same recipe as the search page field — raised fill, 10px radius,
/// accent hairline on focus. Keeps library-style filters consistent instead of each
/// toolbar inventing its own bubble.
struct MacSearchField: View {
    let placeholder: String
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    var maxWidth: CGFloat = 420

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(focused.wrappedValue ? MacTheme.accentDeep : MacTheme.muted)
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .foregroundStyle(MacTheme.ink)
                .focused(focused)
            if !text.isEmpty {
                Button {
                    text = ""
                    focused.wrappedValue = true
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(MacTheme.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n("macSearch.clearSearch"))
                .help(L10n("macSearch.clearSearch"))
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .frame(maxWidth: maxWidth)
        .background(MacTheme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .strokeBorder(focused.wrappedValue ? MacTheme.accent : MacTheme.border, lineWidth: 1))
    }
}

/// Full-width load-more footer for long lists: panel surface with a top hairline,
/// accent text button. Replaces floating bordered pills over scrolled content.
struct MacLoadMoreBar: View {
    let text: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(MacTheme.caption)
                .foregroundStyle(MacTheme.accentDeep)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(MacTheme.panel)
        .overlay(alignment: .top) { Rectangle().fill(MacTheme.border).frame(height: 1) }
        .accessibilityLabel(text)
    }
}

/// Quiet toolbar icon button: plain 14pt glyph, no glass bubble.
/// Disabled state fades to faint instead of showing a system glass grey.
struct MacToolbarIconButton: View {
    let systemImage: String
    let help: String
    var isDisabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(isDisabled ? MacTheme.faint : MacTheme.muted)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .help(help)
        .accessibilityLabel(help)
    }
}

/// Quiet toolbar text action: caption-weight label with optional leading icon, no fill.
/// accent picks accentDeep for the one primary action of the page.
struct MacToolbarTextButton: View {
    let title: String
    var systemImage: String? = nil
    var accent: Bool = false
    var isDisabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let systemImage {
                    Image(systemName: systemImage).font(.system(size: 12, weight: .semibold))
                }
                Text(title).font(MacTheme.caption)
            }
            .foregroundStyle(isDisabled ? MacTheme.faint : (accent ? MacTheme.accentDeep : MacTheme.ink))
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .accessibilityLabel(title)
    }
}

enum MacErrorText {
    static func message(for error: Error) -> String {
        if let network = error as? URLError {
            switch network.code {
            case .timedOut: return L10n("macChrome.errorTimedOut")
            case .notConnectedToInternet, .networkConnectionLost: return L10n("macChrome.errorNetworkLost")
            case .cannotConnectToHost, .cannotFindHost: return L10n("macChrome.errorCannotConnect")
            default: return L10n("macChrome.errorNetworkDefault")
            }
        }
        guard let api = error as? APIError else { return L10n("macChrome.errorUnavailable") }
        switch api.code {
        case "conversation_busy": return L10n("macChrome.errorConversationBusy")
        case "ai_daily_budget_exhausted", "ai_budget_exhausted": return L10n("macChrome.errorAiBudgetExhausted")
        case "connection_not_found", "ai_connection_not_found": return L10n("macChrome.errorAiConnectionNotFound")
        case "podcast_subscriptions_disabled": return L10n("macChrome.errorPodcastSubsDisabled")
        case "podcast_not_found": return L10n("macChrome.errorPodcastNotFound")
        case "podcast_publisher_not_found": return L10n("macChrome.errorPodcastPublisherNotFound")
        case "podcast_publisher_conflict": return L10n("macChrome.errorPodcastPublisherConflict")
        case "podcast_playback_settings_not_found": return L10n("macChrome.errorPodcastPlaybackSettingsNotFound")
        case "episode_not_found": return L10n("macChrome.errorEpisodeNotFound")
        case "episode_unavailable": return L10n("macChrome.errorEpisodeUnavailable")
        case "podcast_search_timeout", "podcast_search_upstream_failed": return L10n("macChrome.errorPodcastSearchFailed")
        case "podcast_feed_fetch_failed", "podcast_feed_parse_failed": return L10n("macChrome.errorPodcastFeedFailed")
        default: break
        }
        switch api.statusCode {
        case 401: return L10n("macChrome.errorAuthExpired")
        case 403: return L10n("macChrome.errorForbidden")
        case 404: return L10n("macChrome.errorNotFound")
        case 409: return L10n("macChrome.errorConflict")
        case 422: return L10n("macChrome.errorUnprocessable", api.code)
        case 429: return L10n("macChrome.errorTooManyRequests")
        default: return L10n("macChrome.errorServerDefault", api.statusCode, api.code)
        }
    }
}

@MainActor
enum MacPages {
    static func collect<Element: Decodable & Sendable>(
        maximum: Int = 2_000,
        fetch: (Int) async throws -> Page<Element>
    ) async throws -> [Element] {
        var collected: [Element] = []
        var offset = 0
        while collected.count < maximum {
            let page = try await fetch(offset)
            if page.items.isEmpty { break }
            collected.append(contentsOf: page.items)
            offset += page.items.count
            if offset >= page.total || page.items.count < page.limit { break }
        }
        return collected
    }

    static func playlists(client: WildstringClient) async throws -> [Playlist] {
        try await collect { offset in
            try await client.playlists(limit: 100, offset: offset)
        }
    }

    static func playlistTracks(client: WildstringClient, playlistID: String) async throws -> [Track] {
        try await collect { offset in
            try await client.playlistTracks(playlistID: playlistID, limit: 200, offset: offset)
        }
    }

    static func artistTracks(client: WildstringClient, artistId: String) async throws -> [Track] {
        try await collect { offset in
            try await client.artistTracks(artistId: artistId, limit: 200, offset: offset)
        }
    }

    static func albumTracks(client: WildstringClient, albumId: String) async throws -> [Track] {
        var collected: [Track] = []
        var offset = 0
        while collected.count < 2_000 {
            let page = try await client.albumTracks(albumId: albumId, limit: 200, offset: offset)
            if page.items.isEmpty { break }
            collected.append(contentsOf: page.items)
            offset += page.items.count
            if offset >= page.total || page.items.count < page.limit { break }
        }
        return collected
    }

    static func favoritesPlaylist(client: WildstringClient) async throws -> Playlist? {
        var offset = 0
        while offset < 2_000 {
            let page = try await client.playlists(limit: 100, offset: offset)
            if let playlist = page.items.first(where: \.isFavorites) { return playlist }
            if page.items.isEmpty || offset + page.items.count >= page.total { return nil }
            offset += page.items.count
        }
        return nil
    }
}

func macClock(milliseconds: Int64) -> String {
  let total = max(0, Int(milliseconds) / 1000)
  return String(format: "%d:%02d", total / 60, total % 60)
}

/// Human total-length line for collection headings, e.g. "2 小时 38 分钟".
func macTotalDurationText(_ tracks: [Track]) -> String {
  let minutes = Int(tracks.reduce(Int64(0)) { $0 + $1.durationMs } / 60_000)
  if minutes >= 60 {
    return L10n("macChrome.durationHoursMinutes", minutes / 60, minutes % 60)
  }
  return L10n("macChrome.durationMinutes", max(minutes, 1))
}

/// "3 分钟前"-style stamp for notification rows; nil when unparsable.
func macRelativeTime(_ iso: String) -> String? {
  let plain = ISO8601DateFormatter()
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  guard let date = fractional.date(from: iso) ?? plain.date(from: iso) else { return nil }
  let relative = RelativeDateTimeFormatter()
  relative.locale = InterfaceLanguage.current.locale
  relative.unitsStyle = .full
  return relative.localizedString(for: date, relativeTo: Date())
}

struct MacCollectionHeading: View {
    let title: String
    var subtitle: String
    var symbol: String
    var canPlay: Bool
    var tileSymbol: String? = nil
    var badge: String? = nil
    var coverTrackID: String? = nil
    var client: WildstringClient? = nil
    var onBack: (() -> Void)? = nil
    var onShuffle: (() -> Void)? = nil
    var play: () -> Void

    var body: some View {
        HStack(spacing: 16) {
            if let onBack {
                Button(action: onBack) {
                    Image(systemName: "chevron.backward")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MacTheme.ink)
                        .frame(width: 32, height: 32)
                        .background(MacTheme.raised, in: Circle())
                        .overlay(Circle().strokeBorder(MacTheme.border))
                }
                .buttonStyle(.plain)
                .help(L10n("macChrome.back"))
                .keyboardShortcut("[", modifiers: .command)
            }
            if let client, let coverTrackID, !coverTrackID.isEmpty {
                MacCover(client: client, trackID: coverTrackID, side: 64, cornerRadius: 12)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(MacTheme.border))
                    .shadow(color: .black.opacity(0.18), radius: 6, x: 0, y: 3)
            } else if let tileSymbol {
                Image(systemName: tileSymbol)
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(MacTheme.onAccent)
                    .frame(width: 64, height: 64)
                    .background(
                        LinearGradient(
                            colors: [MacTheme.accent, MacTheme.accentDeep],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                    )
            } else {
                Image(systemName: symbol)
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(MacTheme.accentDeep)
                    .frame(width: 44, height: 44)
                    .background(
                        MacTheme.accentSoft,
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )
            }
            VStack(alignment: .leading, spacing: 4) {
                if let badge {
                    Text(badge)
                        .font(MacTheme.micro)
                        .foregroundStyle(MacTheme.accentDeep)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(MacTheme.accentSoft, in: Capsule())
                }
                Text(title).font(MacTheme.display(28)).foregroundStyle(MacTheme.ink)
                Text(subtitle).font(MacTheme.caption).foregroundStyle(MacTheme.muted)
            }
            Spacer()
            Button(action: play) {
                Label(L10n("macChrome.playAll"), systemImage: "play.fill")
                    .font(MacTheme.section(13))
            }
            .buttonStyle(.borderedProminent)
            .tint(MacTheme.accentDeep)
            .controlSize(.large)
            .disabled(!canPlay)
            if let onShuffle {
                Button(action: onShuffle) {
                    Label(L10n("macChrome.shuffle"), systemImage: "shuffle")
                        .font(MacTheme.section(13))
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(!canPlay)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 20)
        .background(MacTheme.canvas)
        .overlay(alignment: .bottom) {
            Rectangle().fill(MacTheme.border).frame(height: 1)
        }
    }
}

struct MacCatalogCard<Destination: Hashable>: View {
    let client: WildstringClient
    let value: Destination
    let title: String
    var subtitle: String
    var cover: String?

    var body: some View {
        NavigationLink(value: value) {
            VStack(alignment: .leading, spacing: 8) {
                MacCover(client: client, trackID: cover, side: 148, cornerRadius: 10)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MacTheme.ink)
                        .lineLimit(1)
                    Text(subtitle.isEmpty ? "—" : subtitle)
                        .font(MacTheme.caption)
                        .foregroundStyle(MacTheme.muted)
                        .lineLimit(1)
                }
            }
            .frame(width: 148, alignment: .leading)
            .padding(10)
            .background(
                MacTheme.panel,
                in: RoundedRectangle(cornerRadius: MacTheme.cardRadius, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: MacTheme.cardRadius, style: .continuous)
                    .strokeBorder(MacTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}
