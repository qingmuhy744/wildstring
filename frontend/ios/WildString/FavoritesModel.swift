import CoreNetwork
import Foundation
import Observation

@MainActor
@Observable
final class FavoritesModel {
    private(set) var ids: Set<String> = []
    private(set) var loaded = false

    private let client: WildstringClient

    init(client: WildstringClient) {
        self.client = client
    }

    func load() async {
        guard !loaded else { return }
        do {
            async let trackIDs = client.favoriteIDs()
            async let podcastIDs = client.podcastEpisodeFavoriteIDs()
            let (tracks, podcasts) = try await (trackIDs, podcastIDs)
            ids = tracks.union(podcasts)
            loaded = true
        } catch {
            // Retry on the next screen appearance.
        }
    }

    func isFavorite(_ id: String) -> Bool {
        if ids.contains(id) { return true }
        if id.hasPrefix("podcast_ep_") {
            let bare = String(id.dropFirst("podcast_ep_".count))
            return ids.contains(bare)
        }
        return false
    }

    func toggle(_ trackID: String, isPodcast: Bool = false) async {
        let currentlyLoved = isFavorite(trackID)
        let loved = !currentlyLoved
        let podcast = isPodcast || trackID.hasPrefix("podcast_ep_")
        let episodeID = podcast ? (trackID.hasPrefix("podcast_ep_") ? String(trackID.dropFirst("podcast_ep_".count)) : trackID) : nil
        let targetID = episodeID ?? trackID

        if loved {
            ids.insert(trackID)
            if let ep = episodeID { ids.insert(ep) }
        } else {
            ids.remove(trackID)
            if let ep = episodeID { ids.remove(ep) }
        }
        do {
            if podcast, let ep = episodeID {
                try await client.favoritePodcastEpisode(episodeID: ep, loved: loved)
            } else {
                try await client.setFavorite(trackID: trackID, loved: loved)
            }
        } catch {
            if loved {
                ids.remove(trackID)
                if let ep = episodeID { ids.remove(ep) }
            } else {
                ids.insert(trackID)
                if let ep = episodeID { ids.insert(ep) }
            }
        }
    }

    func refresh() async {
        loaded = false
        await load()
    }
}
