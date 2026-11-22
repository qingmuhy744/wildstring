import CoreNetwork
import CorePlayback
import Foundation
import Observation

@MainActor
@Observable
final class OfflineModel {
    private(set) var items: [OfflineDownloads.Item] = []
    private(set) var stats = OfflineDownloads.Stats(count: 0, totalBytes: 0)

    private let downloads: OfflineDownloads

    init(downloads: OfflineDownloads) {
        self.downloads = downloads
        let downloads = downloads
        OfflineBackgroundEvents.reconnect = {
            Task { await downloads.attachBackgroundSession() }
        }
        Task { await downloads.attachBackgroundSession() }
    }

    func refresh() async {
        items = await downloads.items()
        stats = await downloads.stats()
    }

    func download(_ track: Track) async {
        _ = try? await download([track], confirmed: true)
    }

    func download(_ tracks: [Track], confirmed: Bool) async throws -> OfflineDownloads.BatchResult {
        let result = try await downloads.downloadBatch(tracks.map { track in
            OfflineDownloads.TrackInfo(
                id: track.id,
                title: track.title,
                artist: track.artistDisplay,
                streamPath: "api/v1/tracks/\(track.id)/stream"
            )
        }, confirmed: confirmed)
        if result == .started { await refresh() }
        return result
    }

    func download(episode: PodcastEpisode, podcastTitle: String) async throws {
        _ = try await downloads.downloadBatch([
            OfflineDownloads.TrackInfo(
                id: "podcast_ep_\(episode.id)",
                title: episode.title,
                artist: podcastTitle,
                streamPath: "api/v1/podcasts/episodes/\(episode.id)/stream?proxy=1&download=1"
            )
        ], confirmed: true)
        await refresh()
    }

    func remove(trackID: String) async {
        await downloads.remove(trackID: trackID)
        await refresh()
    }

    func clearAll() async {
        await downloads.clearAll()
        await refresh()
    }

    func shutdown() async {
        OfflineBackgroundEvents.reconnect = nil
        await downloads.shutdown()
    }
}
