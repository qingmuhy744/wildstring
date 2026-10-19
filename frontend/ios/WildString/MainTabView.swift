import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct MainTabView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let favorites: FavoritesModel
    let offline: OfflineModel
    let sharing: PlaybackSharingModel
    let isAdmin: Bool
    let server: String
    let username: String
    var autoPlayFirst = false
    let onLogout: () -> Void

    @State private var selection: Int = Self.demoTab

    var body: some View {
        TabView(selection: $selection) {
            BrowseView(client: client, playback: playback, autoPlayFirst: autoPlayFirst)
                .tabItem { Label("曲库", systemImage: "music.note.list") }
                .tag(0)
            DailyRecommendationsView(client: client, playback: playback)
                .tabItem { Label("推荐", systemImage: "sparkles") }
                .tag(1)
            SearchView(client: client, playback: playback)
                .tabItem { Label("搜索", systemImage: "magnifyingglass") }
                .tag(2)
            AccountView(
                client: client,
                playback: playback,
                server: server,
                username: username,
                onLogout: onLogout
            )
            .tabItem { Label("我的", systemImage: "person.crop.circle") }
            .tag(3)
        }
        .environment(favorites)
        .environment(offline)
        .environment(\.isAdmin, isAdmin)
        .overlay(alignment: .top) {
            if let handoff = sharing.handoff {
                handoffBanner(handoff)
            }
        }
        .onChange(of: playback.isPlaying) { _, playing in
            if !playing {
                Task { await sharing.publishIfPaused() }
            }
        }
        .task {
            await favorites.load()
            await downloadDemoTrackIfNeeded()
            sharing.start()
        }
    }

    private func handoffBanner(_ handoff: PlaybackSharingModel.Handoff) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                .foregroundStyle(Color.wildAccent)
            VStack(alignment: .leading, spacing: 1) {
                Text("其他设备有可接续的进度")
                    .font(.footnote.bold())
                if handoff.tracks.indices.contains(handoff.state.index) {
                    Text(handoff.tracks[handoff.state.index].title)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            Button("忽略") { sharing.dismiss() }
                .font(.footnote)
                .buttonStyle(.plain)
            Button("继续") {
                Task { await sharing.accept(handoff) }
            }
            .font(.footnote.bold())
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 12)
        .padding(.top, 6)
    }

    private func downloadDemoTrackIfNeeded() async {
        #if DEBUG
            guard ProcessInfo.processInfo.environment["WILDSTRING_DEMO_DOWNLOAD"] == "1"
            else { return }
            do {
                let page = try await client.tracks(limit: 1)
                if let first = page.items.first {
                    await offline.download(first)
                }
            } catch {
                // Demo hook only.
            }
        #endif
    }

    /// Debug-only hook used by the simulator verification runs.
    private static var demoTab: Int {
        #if DEBUG
            switch ProcessInfo.processInfo.environment["WILDSTRING_DEMO_TAB"] {
            case "recommendations": return 1
            case "search": return 2
            case "account": return 3
            default: return 0
            }
        #else
            return 0
        #endif
    }
}
