import CoreNetwork
import CorePlayback
import Foundation
import SwiftUI

@MainActor
struct LibraryView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let server: String
    let username: String
    var autoPlayFirst = false
    let onLogout: () -> Void

    @State private var tracks: [Track] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var didAutoPlay = false

    var body: some View {
        NavigationStack {
            Group {
                if isLoading, tracks.isEmpty {
                    ProgressView("正在加载曲库…")
                } else if let errorMessage, tracks.isEmpty {
                    ContentUnavailableView {
                        Label("无法加载曲库", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("重试") { Task { await load() } }
                    }
                } else if tracks.isEmpty {
                    ContentUnavailableView(
                        "曲库为空",
                        systemImage: "music.note.list",
                        description: Text("请先在网页端或服务端导入曲目。")
                    )
                } else {
                    list
                }
            }
            .navigationTitle("曲库")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Section("\(username) · \(server)") {
                            Button("退出登录", role: .destructive, action: onLogout)
                        }
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 0) {
                    if let message = playback.errorMessage {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                            Text(message)
                                .lineLimit(2)
                            Spacer(minLength: 0)
                        }
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity)
                        .background(.bar)
                    }
                    MiniPlayerBar(playback: playback)
                }
            }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private var list: some View {
        List(tracks) { track in
            Button {
                play(track)
            } label: {
                TrackRow(track: track, isCurrent: playback.currentItem?.trackID == track.id)
            }
            .buttonStyle(.plain)
        }
        .listStyle(.plain)
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        do {
            let page = try await client.tracks(limit: 200)
            tracks = page.items
            if autoPlayFirst, !didAutoPlay, let first = tracks.first {
                didAutoPlay = true
                play(first)
            }
        } catch {
            errorMessage = Self.message(for: error)
        }
        isLoading = false
    }

    private func play(_ track: Track) {
        guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
        playback.play(items: tracks.map(\.playbackItem), startingAt: index)
    }

    private static func message(for error: Error) -> String {
        if let error = error as? APIError {
            switch error.code {
            case "authentication_required": return "登录已过期，请重新登录"
            default: return "服务器返回错误（\(error.statusCode)）"
            }
        }
        if let error = error as? URLError {
            switch error.code {
            case .timedOut: return "连接超时，请检查网络"
            case .notConnectedToInternet: return "当前网络不可用"
            default: return "网络错误（\(error.code.rawValue)）"
            }
        }
        return "发生未知错误"
    }
}

private struct TrackRow: View {
    let track: Track
    let isCurrent: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(track.title)
                    .foregroundStyle(isCurrent ? Color.accentColor : .primary)
                    .lineLimit(1)
                Text(track.artistDisplay)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if isCurrent {
                Image(systemName: "speaker.wave.2.fill")
                    .font(.caption)
                    .foregroundStyle(Color.accentColor)
            }
            Text(track.durationText)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }
}

extension Track {
    var artistDisplay: String {
        let joined = artists.joined(separator: " / ")
        return joined.isEmpty ? "未知艺人" : joined
    }

    var durationText: String {
        let seconds = max(0, durationMs) / 1000
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    var playbackItem: PlaybackService.Item {
        PlaybackService.Item(
            trackID: id,
            title: title,
            artist: artistDisplay,
            streamPath: "api/v1/tracks/\(id)/stream"
        )
    }
}
