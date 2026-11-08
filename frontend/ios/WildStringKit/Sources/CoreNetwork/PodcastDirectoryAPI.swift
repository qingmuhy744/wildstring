import Foundation

public struct PodcastDirectoryResult: Decodable, Sendable, Identifiable {
    public var id: String { feedURL }
    public let itunesID: String?
    public let title: String
    public let author: String
    public let feedURL: String
    public let artworkURL: String
    public let genres: [String]
    public let explicit: Bool
    public let catalogPodcastID: String?
    public let followed: Bool
    enum CodingKeys: String, CodingKey {
        case title, author, genres, explicit, followed
        case itunesID = "itunes_id", feedURL = "feed_url", artworkURL = "artwork_url"
        case catalogPodcastID = "catalog_podcast_id"
    }
}

public struct PodcastDirectoryPage: Decodable, Sendable {
    public let results: [PodcastDirectoryResult]
    public let regions: [String]
    public let explicitHidden: Int
    public let failedRegions: [FailedRegion]
    public struct FailedRegion: Decodable, Sendable { public let region: String; public let code: String }
    enum CodingKeys: String, CodingKey {
        case results, regions
        case explicitHidden = "explicit_hidden", failedRegions = "failed_regions"
    }
}

public struct PodcastFeedPreview: Decodable, Sendable {
    public let title: String
    public let author: String
    public let description: String
    public let episodeCount: Int
    public let latestEpisodes: [Episode]
    public let catalogPodcastID: String?
    public let followed: Bool
    public struct Episode: Decodable, Sendable {
        public let title: String
        public let pubDate: String?
        enum CodingKeys: String, CodingKey { case title; case pubDate = "pub_date" }
    }
    enum CodingKeys: String, CodingKey {
        case title, author, description, followed
        case episodeCount = "episode_count", latestEpisodes = "latest_episodes", catalogPodcastID = "catalog_podcast_id"
    }
}

public final class PodcastDiscoveryCache: @unchecked Sendable {
    public static let shared = PodcastDiscoveryCache()

    private let ttl: TimeInterval
    private let lock = NSLock()
    private var entries: [String: (timestamp: Date, page: PodcastDirectoryPage)] = [:]

    public init(ttl: TimeInterval = 3600) {
        self.ttl = ttl
    }

    public func get(region: String) -> PodcastDirectoryPage? {
        lock.lock()
        defer { lock.unlock() }
        guard let entry = entries[region] else { return nil }
        if Date().timeIntervalSince(entry.timestamp) > ttl {
            entries.removeValue(forKey: region)
            return nil
        }
        return entry.page
    }

    public func set(region: String, page: PodcastDirectoryPage) {
        lock.lock()
        defer { lock.unlock() }
        entries[region] = (timestamp: Date(), page: page)
    }

    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll()
    }
}

extension WildstringClient {
    public func prefetchPodcastDirectory(region: String) async {
        if PodcastDiscoveryCache.shared.get(region: region) != nil {
            return
        }
        _ = try? await podcastDirectory(query: "", region: region)
    }

    public func podcastDirectory(query: String, region: String) async throws -> PodcastDirectoryPage {
        let searching = !query.isEmpty
        if !searching, let cached = PodcastDiscoveryCache.shared.get(region: region) {
            return cached
        }
        let data = try await perform(Request(method: "GET", path: searching ? "api/v1/podcasts/search" : "api/v1/podcasts/discover",
            queryItems: searching ? [URLQueryItem(name: "q", value: query)] : region.isEmpty ? [] : [URLQueryItem(name: "region", value: region)]))
        let page = try JSONDecoder().decode(PodcastDirectoryPage.self, from: data)
        if !searching {
            PodcastDiscoveryCache.shared.set(region: region, page: page)
        }
        return page
    }

    public func previewPodcast(feedURL: String) async throws -> PodcastFeedPreview {
        struct Body: Encodable { let feed_url: String }
        let data = try await perform(Request(method: "POST", path: "api/v1/podcasts/preview",
            body: try JSONEncoder().encode(Body(feed_url: feedURL)), contentType: "application/json"))
        return try JSONDecoder().decode(PodcastFeedPreview.self, from: data)
    }

    public func addPodcast(feedURL: String, itunesID: String?) async throws -> PodcastDetail {
        struct Body: Encodable { let feed_url: String; let itunes_id: String? }
        let data = try await perform(Request(method: "POST", path: "api/v1/podcasts",
            body: try JSONEncoder().encode(Body(feed_url: feedURL, itunes_id: itunesID)), contentType: "application/json"))
        return try JSONDecoder().decode(PodcastDetail.self, from: data)
    }

    public func canAddPodcasts() async throws -> Bool {
        struct Policy: Decodable { let can_add: Bool }
        let data = try await perform(Request(method: "GET", path: "api/v1/podcasts/catalog-settings"))
        return try JSONDecoder().decode(Policy.self, from: data).can_add
    }
}
