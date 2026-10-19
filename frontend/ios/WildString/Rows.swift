import CoreNetwork
import CorePlayback
import Foundation
import SwiftUI

struct TrackRow: View {
    let client: WildstringClient
    let track: Track
    let isCurrent: Bool

    @AppStorage("songListSize") private var listSizeRaw = SongListSize.medium.rawValue

    private var listSize: SongListSize {
        SongListSize(rawValue: listSizeRaw) ?? .medium
    }

    var body: some View {
        HStack(spacing: 12) {
            CoverImage(
                client: client,
                trackID: track.hasCover ? track.id : nil,
                size: listSize.coverSide
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(track.title)
                    .font(listSize.titleFont)
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

struct AlbumRow: View {
    let client: WildstringClient
    let album: Album

    var body: some View {
        HStack(spacing: 12) {
            CoverImage(client: client, trackID: album.coverTrackId, size: 52)
            VStack(alignment: .leading, spacing: 2) {
                Text(album.title)
                    .lineLimit(1)
                Text(album.artistDisplay)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text("\(album.trackCount) 首")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

struct ArtistRow: View {
    let client: WildstringClient
    let artist: Artist

    var body: some View {
        HStack(spacing: 12) {
            CoverImage(client: client, trackID: artist.coverTrackId, size: 52, circular: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(artist.name)
                    .lineLimit(1)
                Text("\(artist.trackCount) 首 · \(artist.albumCount) 张专辑")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

/// Paged list with infinite scroll, pull-to-refresh and real empty/error states.
struct LoadedList<Element: Decodable & Identifiable & Sendable, Row: View>: View {
    let loader: PagedListModel<Element>
    let emptyTitle: String
    let emptyIcon: String
    var onMove: ((IndexSet, Int) -> Void)?
    let row: (Element) -> Row

    var body: some View {
        List {
            ForEach(loader.items) { element in
                row(element)
                    .onAppear {
                        if loader.items.last?.id == element.id {
                            Task { await loader.loadMore() }
                        }
                    }
            }
            .onMove(perform: onMove)
            if loader.isLoading, !loader.items.isEmpty {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .listRowSeparator(.hidden)
            }
            if let message = loader.errorMessage, !loader.items.isEmpty {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .listStyle(.plain)
        .refreshable { await loader.loadInitial() }
        .overlay {
            if !loader.didLoadOnce {
                ProgressView()
            } else if loader.items.isEmpty {
                ContentUnavailableView(
                    emptyTitle,
                    systemImage: emptyIcon,
                    description: Text(loader.errorMessage ?? "没有可显示的内容")
                )
            }
        }
    }
}

@MainActor
func playTracks(_ tracks: [Track], startingAt track: Track, using playback: PlaybackService) {
    guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
    Haptics.tap()
    playback.play(items: tracks.map(\.playbackItem), startingAt: index)
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
            album: album,
            streamPath: "api/v1/tracks/\(id)/stream"
        )
    }
}

extension Album {
    var artistDisplay: String {
        let joined = artists.joined(separator: " / ")
        return joined.isEmpty ? "未知艺人" : joined
    }
}
