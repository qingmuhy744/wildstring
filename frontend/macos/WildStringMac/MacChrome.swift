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

    static let canvas = adaptive(light: 0xF6F3ED, dark: 0x171716)
    static let sidebar = adaptive(light: 0xEEEEE5, dark: 0x1C1E18)
    static let panel = adaptive(light: 0xFAF9F4, dark: 0x22251E)
    static let raised = adaptive(light: 0xFFFDF8, dark: 0x292C24)
    static let border = adaptive(light: 0xDEDED2, dark: 0x33342E)
    static let ink = adaptive(light: 0x2A2B25, dark: 0xEEEAE2)
    static let muted = adaptive(light: 0x626457, dark: 0xA8A59C)
    static let faint = adaptive(light: 0x8A8E7D, dark: 0x8E9284)
    static let accent = adaptive(light: 0xBC5438, dark: 0xE98A6D)
    static let accentDeep = adaptive(light: 0x9F422B, dark: 0xE98A6D)
    static let accentSoft = adaptive(light: 0xDDE2D0, dark: 0x262B21)
    static let olive = adaptive(light: 0x57492F, dark: 0xB4C09E)
    static let oliveSoft = adaptive(light: 0xE4E7DB, dark: 0x30352A)
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

enum MacErrorText {
    static func message(for error: Error) -> String {
        if let network = error as? URLError {
            switch network.code {
            case .timedOut: return "连接超时"
            case .notConnectedToInternet, .networkConnectionLost: return "网络连接已中断"
            case .cannotConnectToHost, .cannotFindHost: return "暂时无法连接服务器"
            default: return "网络请求未完成"
            }
        }
        guard let api = error as? APIError else { return "网络或数据暂时不可用" }
        switch api.code {
        case "conversation_busy": return "这段对话仍在处理上一条消息"
        case "ai_daily_budget_exhausted", "ai_budget_exhausted": return "所选模型今天的调用额度已用完"
        case "connection_not_found", "ai_connection_not_found": return "所选模型连接已不可用，请重新选择"
        case "podcast_subscriptions_disabled": return "管理员尚未开放添加节目"
        case "podcast_search_timeout", "podcast_search_upstream_failed": return "播客目录暂时不可用，请稍后重试"
        case "podcast_feed_fetch_failed", "podcast_feed_parse_failed": return "无法读取这个节目的 RSS，请稍后重试"
        default: break
        }
        switch api.statusCode {
        case 401: return "登录已失效"
        case 403: return "没有权限做这件事"
        case 404: return "内容不存在"
        case 409: return "内容和服务器上的版本不一致，请刷新后再试"
        case 422: return "请求没有被接受（\(api.code)）"
        case 429: return "请求较频繁，请稍后重试"
        default: return "服务器返回 \(api.statusCode) \(api.code)"
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
    return "\(minutes / 60) 小时 \(minutes % 60) 分钟"
  }
  return "\(max(minutes, 1)) 分钟"
}

struct MacCollectionHeading: View {
    let title: String
    var subtitle: String
    var symbol: String
    var canPlay: Bool
    var tileSymbol: String? = nil
    var badge: String? = nil
    var onShuffle: (() -> Void)? = nil
    var play: () -> Void

    var body: some View {
        HStack(spacing: 16) {
            if let tileSymbol {
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
                Label("播放全部", systemImage: "play.fill")
                    .font(MacTheme.section(13))
            }
            .buttonStyle(.borderedProminent)
            .tint(MacTheme.accentDeep)
            .controlSize(.large)
            .disabled(!canPlay)
            if let onShuffle {
                Button(action: onShuffle) {
                    Label("随机", systemImage: "shuffle")
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
