import CoreNetwork
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
        case .title, .name: "名称"
        case .trackNumber: "曲序"
        case .addedAt: "入库时间"
        case .duration: "时长"
        case .playCount: "播放次数"
        case .listened: "收听时长"
        case .lastPlayed: "最近听过"
        }
    }

    static func label(_ sort: AlbumSort) -> String {
        switch sort {
        case .title: "专辑名"
        case .artist: "艺人"
        case .addedAt: "入库时间"
        case .releaseDate: "发行时间"
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

    init(
        pageSize: Int = 200,
        fetchPage: @escaping (Int, Int) async throws -> AlbumTrackPage
    ) {
        self.pageSize = pageSize
        self.fetchPage = fetchPage
    }

    var canLoadMore: Bool { items.count < total }

    func loadInitial() async {
        items = []
        discs = []
        total = 0
        nextOffset = 0
        didLoadOnce = false
        errorMessage = nil
        await loadMore()
    }

    func loadMore() async {
        guard !isLoading else { return }
        if didLoadOnce, !canLoadMore { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await fetchPage(pageSize, nextOffset)
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
            errorMessage = ErrorText.message(for: error)
            didLoadOnce = true
        }
    }
}
