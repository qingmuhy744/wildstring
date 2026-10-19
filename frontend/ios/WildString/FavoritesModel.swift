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
            ids = try await client.favoriteIDs()
            loaded = true
        } catch {
            // Retry on the next screen appearance.
        }
    }

    func isFavorite(_ trackID: String) -> Bool {
        ids.contains(trackID)
    }

    func toggle(_ trackID: String) async {
        let loved = !ids.contains(trackID)
        if loved {
            ids.insert(trackID)
        } else {
            ids.remove(trackID)
        }
        do {
            try await client.setFavorite(trackID: trackID, loved: loved)
        } catch {
            if loved {
                ids.remove(trackID)
            } else {
                ids.insert(trackID)
            }
        }
    }

    func refresh() async {
        loaded = false
        await load()
    }
}
