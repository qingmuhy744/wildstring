import CoreNetwork
import CorePlayback
import Foundation
import Observation

enum CatalogSorting {
    static let songSorts: [TrackSort] = [
        .name, .addedAt, .duration, .playCount, .listened, .lastPlayed, .trackNumber,
    ]

    static let albumSorts: [AlbumSort] = [
        .title, .artist, .addedAt, .releaseDate,
    ]

    static func label(_ sort: TrackSort) -> String {
        switch sort {
        case .title, .name: L10n("catalogSort.name")
        case .trackNumber: L10n("catalogSort.trackNumber")
        case .addedAt: L10n("catalogSort.addedAt")
        case .duration: L10n("catalogSort.duration")
        case .playCount: L10n("catalogSort.playCount")
        case .listened: L10n("catalogSort.listened")
        case .lastPlayed: L10n("catalogSort.lastPlayed")
        }
    }

    static func label(_ sort: AlbumSort) -> String {
        switch sort {
        case .title: L10n("catalogSort.albumTitle")
        case .artist: L10n("catalogSort.artist")
        case .addedAt: L10n("catalogSort.addedAt")
        case .releaseDate: L10n("catalogSort.releaseDate")
        }
    }

    static func defaultOrder(for sort: TrackSort) -> CatalogSortOrder {
        switch sort {
        case .name, .title, .trackNumber: .asc
        default: .desc
        }
    }

    static func defaultOrder(for sort: AlbumSort) -> CatalogSortOrder {
        switch sort {
        case .title, .artist: .asc
        case .addedAt, .releaseDate: .desc
        }
    }
}

/// Sort preferences are stored per server origin so two instances do not
/// overwrite each other. Same-server accounts share the preference.
struct CatalogSortPreference {
    private let defaults: UserDefaults
    private let prefix: String

    init(origin: String, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        prefix = "catalog.\(origin)."
    }

    var songSort: TrackSort {
        get {
            TrackSort(rawValue: defaults.string(forKey: prefix + "songSort") ?? "") ?? .name
        }
        nonmutating set {
            defaults.set(newValue.rawValue, forKey: prefix + "songSort")
        }
    }

    var songOrder: CatalogSortOrder {
        get {
            CatalogSortOrder(rawValue: defaults.string(forKey: prefix + "songOrder") ?? "") ?? .asc
        }
        nonmutating set {
            defaults.set(newValue.rawValue, forKey: prefix + "songOrder")
        }
    }

    var albumSort: AlbumSort {
        get {
            AlbumSort(rawValue: defaults.string(forKey: prefix + "albumSort") ?? "") ?? .title
        }
        nonmutating set {
            defaults.set(newValue.rawValue, forKey: prefix + "albumSort")
        }
    }

    var albumOrder: CatalogSortOrder {
        get {
            CatalogSortOrder(rawValue: defaults.string(forKey: prefix + "albumOrder") ?? "") ?? .asc
        }
        nonmutating set {
            defaults.set(newValue.rawValue, forKey: prefix + "albumOrder")
        }
    }

    var albumTracksSort: TrackSort {
        get {
            TrackSort(rawValue: defaults.string(forKey: prefix + "albumTracksSort") ?? "")
                ?? .trackNumber
        }
        nonmutating set {
            defaults.set(newValue.rawValue, forKey: prefix + "albumTracksSort")
        }
    }

    var albumTracksOrder: CatalogSortOrder {
        get {
            CatalogSortOrder(rawValue: defaults.string(forKey: prefix + "albumTracksOrder") ?? "")
                ?? .asc
        }
        nonmutating set {
            defaults.set(newValue.rawValue, forKey: prefix + "albumTracksOrder")
        }
    }

    var artistSongSort: TrackSort {
        get {
            TrackSort(rawValue: defaults.string(forKey: prefix + "artistSongSort") ?? "")
                ?? .name
        }
        nonmutating set {
            defaults.set(newValue.rawValue, forKey: prefix + "artistSongSort")
        }
    }

    var artistSongOrder: CatalogSortOrder {
        get {
            CatalogSortOrder(rawValue: defaults.string(forKey: prefix + "artistSongOrder") ?? "")
                ?? .asc
        }
        nonmutating set {
            defaults.set(newValue.rawValue, forKey: prefix + "artistSongOrder")
        }
    }
}

@MainActor
@Observable
final class AlbumTracksModel {
    private(set) var items: [Track] = []
    private(set) var discs: [DiscSummary] = []
    private(set) var total = 0
    private(set) var isLoading = false
    private(set) var didLoadOnce = false
    private(set) var errorMessage: String?

    private let pageSize: Int
    private let fetchPage: (Int, Int) async throws -> AlbumTrackPage
    private var nextOffset = 0
    private var revision = 0

    init(
        pageSize: Int = 200,
        fetchPage: @escaping (Int, Int) async throws -> AlbumTrackPage
    ) {
        self.pageSize = pageSize
        self.fetchPage = fetchPage
    }

    var canLoadMore: Bool { items.count < total }

    func loadInitial() async {
        revision += 1
        isLoading = false
        items = []
        discs = []
        total = 0
        nextOffset = 0
        didLoadOnce = false
        errorMessage = nil
        await loadMore()
    }

    func allItems() async throws -> [Track] {
        var offset = 0
        var tracks: [Track] = []
        while true {
            try Task.checkCancellation()
            let page = try await fetchPage(pageSize, offset)
            tracks.append(contentsOf: page.items)
            offset += page.items.count
            if page.items.isEmpty || offset >= page.total { return tracks }
        }
    }

    func play(_ track: Track, using playback: PlaybackService) {
        guard let index = items.firstIndex(where: { $0.id == track.id }) else { return }
        let token = playback.beginMusicSelection()
        let selectionRevision = revision
        let sourceTotal = total
        guard index < sourceTotal else { errorMessage = L10n("playback.collectionChanged"); return }
        let start = sourceTotal > PlaybackService.musicQueueLimit ? index : 0
        let count = min(PlaybackService.musicQueueLimit, sourceTotal - start)
        guard count > 0 else { return }
        Task {
            do {
                let tracks: [Track]
                if start + count <= items.count {
                    tracks = Array(items[start..<(start + count)])
                } else {
                    let page = try await fetchPage(count, start)
                    guard playback.isCurrentMusicSelection(token), selectionRevision == revision else { return }
                    guard page.total == sourceTotal, page.items.count == count else {
                        errorMessage = L10n("playback.collectionChanged")
                        return
                    }
                    tracks = page.items
                }
                guard playback.isCurrentMusicSelection(token), selectionRevision == revision else { return }
                guard tracks[index - start].id == track.id else { errorMessage = L10n("playback.collectionChanged"); return }
                playback.play(items: tracks.map(\.playbackItem), startingAt: index - start, sourceCount: sourceTotal)
            } catch {
                guard playback.isCurrentMusicSelection(token) else { return }
                errorMessage = ErrorText.message(for: error)
            }
        }
    }

    func loadMore() async {
        guard !isLoading else { return }
        if didLoadOnce, !canLoadMore { return }
        let loadingRevision = revision
        isLoading = true
        defer {
            if loadingRevision == revision { isLoading = false }
        }
        do {
            let page = try await fetchPage(pageSize, nextOffset)
            guard loadingRevision == revision, !Task.isCancelled else { return }
            var seen = Set(items.map(\.id))
            for item in page.items where seen.insert(item.id).inserted {
                items.append(item)
            }
            discs = page.discs
            nextOffset += page.items.count
            total = page.total
            didLoadOnce = true
            errorMessage = nil
        } catch {
            guard loadingRevision == revision, !Task.isCancelled else { return }
            errorMessage = ErrorText.message(for: error)
            didLoadOnce = true
        }
    }
}
