import CoreNetwork
import SwiftUI

enum MacTheme {
    /// Web light accent `#e98a6d`.
    static let accent = Color(red: 233 / 255, green: 138 / 255, blue: 109 / 255)
    /// Keep accent text readable in both window appearances.
    static let accentDeep = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(red: 233 / 255, green: 138 / 255, blue: 109 / 255, alpha: 1)
            : NSColor(red: 188 / 255, green: 84 / 255, blue: 56 / 255, alpha: 1)
    })
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
        default: break
        }
        switch api.statusCode {
        case 401: return "登录已失效"
        case 403: return "没有权限做这件事"
        case 404: return "内容不存在"
        case 409: return "内容和服务器上的版本不一致，请刷新后再试"
        case 422: return "请求没有被接受（\(api.code)）"
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
    let total = max(0, Int(milliseconds / 1000))
    return String(format: "%d:%02d", total / 60, total % 60)
}

struct MacCollectionHeading: View {
    let title: String
    var subtitle: String
    var symbol: String
    var canPlay: Bool
    var play: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(MacTheme.accentDeep)
                .frame(width: 48, height: 48)
                .background(
                    MacTheme.accent.opacity(0.18),
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.title2.bold())
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
            Button(action: play) {
                Label("播放", systemImage: "play.fill")
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canPlay)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
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
                MacCover(client: client, trackID: cover, side: 156)
                Text(title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(width: 156, alignment: .leading)
        }
        .buttonStyle(.plain)
    }
}
