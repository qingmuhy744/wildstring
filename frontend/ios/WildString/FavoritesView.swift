import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct FavoritesView: View {
    let client: WildstringClient
    let playback: PlaybackService

    @State private var loader: PagedListModel<Track>?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let loader {
                LoadedList(
                    loader: loader,
                    emptyTitle: "还没有收藏",
                    emptyIcon: "heart"
                ) { track in
                    TrackActionRow(client: client, track: track) {
                        Button {
                            playTracks(loader.items, startingAt: track, using: playback)
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
            } else if let errorMessage {
                ContentUnavailableView(
                    "无法加载收藏",
                    systemImage: "heart.slash",
                    description: Text(errorMessage)
                )
            } else {
                ProgressView()
            }
        }
        .navigationTitle("我喜欢的音乐")
        .navigationBarTitleDisplayMode(.inline)
        .miniPlayer(playback, client: client)
        .task { await load() }
    }

    private func load() async {
        guard loader == nil else { return }
        do {
            let page = try await client.playlists()
            guard let favorites = page.items.first(where: \.isFavorites) else {
                errorMessage = "服务器上还没有默认收藏歌单"
                return
            }
            let loader = PagedListModel<Track>(pageSize: 200) { [client, id = favorites.id] limit, offset in
                try await client.playlistTracks(playlistID: id, limit: limit, offset: offset)
            }
            self.loader = loader
            await loader.loadInitial()
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }
}
