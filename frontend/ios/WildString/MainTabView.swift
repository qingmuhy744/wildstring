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
            DiscoverView(client: client, playback: playback)
                .tabItem { Label("tab.discover", systemImage: "sparkles") }
                .tag(0)
            PodcastsView(client: client, playback: playback)
                .tabItem { Label("tab.radio", systemImage: "antenna.radiowaves.left.and.right") }
                .tag(1)
            AssistantView(client: client, showsDismiss: false)
                .tabItem { Label("tab.assistant", systemImage: "bubble.left.and.bubble.right") }
                .tag(2)
            BrowseView(
                client: client,
                playback: playback,
                server: server,
                username: username,
                autoPlayFirst: autoPlayFirst
            )
            .tabItem { Label("tab.music", systemImage: "music.note") }
            .tag(3)
            AccountView(
                client: client,
                playback: playback,
                server: server,
                username: username,
                onLogout: onLogout
            )
            .tabItem { Label("tab.mine", systemImage: "person.crop.circle") }
            .tag(4)
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
            if playing {
                sharing.localPlaybackStarted()
            }
            Task { await sharing.publishCurrent() }
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
                Text("handoff.available")
                    .font(.footnote.bold())
                if handoff.tracks.indices.contains(handoff.state.index) {
                    Text(handoff.tracks[handoff.state.index].title)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            Button("handoff.dismiss") { sharing.dismiss() }
                .font(.footnote)
                .buttonStyle(.plain)
            Button("handoff.continue") {
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
            if ProcessInfo.processInfo.environment["WILDSTRING_DEMO_OPEN_ASSISTANT"] == "1" {
                return 2
            }
            switch ProcessInfo.processInfo.environment["WILDSTRING_DEMO_TAB"] {
            case "recommendations", "discover": return 0
            case "podcasts", "radio": return 1
            case "assistant": return 2
            case "search", "library", "browse": return 3
            case "account": return 4
            default: return 3
            }
        #else
            return 0
        #endif
    }
}
