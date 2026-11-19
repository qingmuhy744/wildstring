import CoreNetwork
import Foundation
import Testing
@testable import WildString

@Suite("Podcast episode projection")
struct MacPodcastProjectionTests {
    @Test func groupsFiltersAndOrdersAroundSevenDayBoundary() throws {
        let now = try #require(ISO8601DateFormatter().date(from: "2026-11-19T12:00:00Z"))
        let episodes = [
            PodcastEpisode(id: "new", podcastId: "show", title: "New", pubDate: "2026-11-19T10:00:00Z", completed: false),
            PodcastEpisode(id: "edge", podcastId: "show", title: "Edge", pubDate: "2026-11-12T12:00:00Z", completed: true),
            PodcastEpisode(id: "old", podcastId: "show", title: "Old", pubDate: "2026-11-12T11:59:59Z", completed: false, loved: true),
            PodcastEpisode(id: "missing", podcastId: "show", title: "Missing", pubDate: "invalid", completed: true),
        ]
        func key(_ filter: String, _ newest: Bool, _ favorites: Set<String>? = nil) -> MacPodcastProjectionKey {
            .init(revision: 1, showID: "show", filter: filter, newestFirst: newest, favoriteIDs: favorites)
        }
        let all = MacPodcastProjection.make(episodes: episodes, key: key("all", true), now: now)
        #expect(all.groups.map { $0.episodes.map(\.id) } == [["new", "edge"], ["old", "missing"]])
        #expect(all.completedCount == 2)
        #expect(all.favoriteCount == 1)
        #expect(all.nextChange == now)
        let ascending = MacPodcastProjection.make(episodes: episodes, key: key("all", false), now: now)
        #expect(ascending.groups.map { $0.episodes.map(\.id) } == [["missing", "old"], ["edge", "new"]])
        let favorites = MacPodcastProjection.make(episodes: episodes, key: key("favorite", true, ["podcast_ep_edge"]), now: now)
        #expect(favorites.favoriteCount == 1)
        #expect(favorites.groups.flatMap(\.episodes).map(\.id) == ["edge"])
        let unplayed = MacPodcastProjection.make(episodes: episodes, key: key("unplayed", true), now: now)
        #expect(unplayed.groups.flatMap(\.episodes).map(\.id) == ["new", "old"])
        let after = MacPodcastProjection.make(episodes: episodes, key: key("all", true), now: now.addingTimeInterval(1))
        #expect(after.groups.map { $0.episodes.map(\.id) } == [["new"], ["edge", "old", "missing"]])
    }
}
