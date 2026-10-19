import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct SearchView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var query = ""
    @State private var tracks: [Track] = []
    @State private var isSearching = false
    @State private var hasSearched = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                ForEach(tracks) { track in
                    TrackActionRow(client: client, track: track) {
                        Button {
                            playTracks(tracks, startingAt: track, using: playback)
                        } label: {
                            TrackRow(
                                client: client,
                                track: track,
                                isCurrent: playback.currentItem?.trackID == track.id
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                if isSearching {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                    .listRowSeparator(.hidden)
                }
                if let errorMessage, !tracks.isEmpty {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .listStyle(.plain)
            .overlay {
                if !hasSearched, query.trimmingCharacters(in: .whitespaces).isEmpty {
                    ContentUnavailableView(
                        "搜索曲库",
                        systemImage: "magnifyingglass",
                        description: Text("输入歌名、艺人或专辑关键词。")
                    )
                } else if hasSearched, tracks.isEmpty, !isSearching {
                    ContentUnavailableView.search(text: query)
                }
            }
            .navigationTitle("搜索")
            .searchable(text: $query, prompt: "歌曲、艺人或专辑")
            .task(id: query) { await runSearch() }
            .miniPlayer(playback, client: client)
        }
    }

    private func runSearch() async {
        let text = query.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else {
            tracks = []
            hasSearched = false
            errorMessage = nil
            return
        }
        do {
            try await Task.sleep(for: .milliseconds(320))
        } catch {
            return
        }
        guard !Task.isCancelled else { return }
        isSearching = true
        defer { isSearching = false }
        do {
            let page = try await client.tracks(limit: 100, query: text)
            tracks = page.items
            hasSearched = true
            errorMessage = nil
        } catch {
            errorMessage = ErrorText.message(for: error)
            hasSearched = true
        }
    }
}
