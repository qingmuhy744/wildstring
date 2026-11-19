import CoreNetwork
import Foundation

struct MacPodcastProjectionKey: Equatable, Sendable {
    let revision: Int
    let showID: String?
    let filter: String
    let newestFirst: Bool
    let favoriteIDs: Set<String>?
}

struct MacPodcastProjection: Sendable {
    struct Group: Sendable {
        enum Heading: Sendable { case recent, older, none }
        let heading: Heading
        let episodes: [PodcastEpisode]
    }

    let key: MacPodcastProjectionKey
    let completedCount: Int
    let favoriteCount: Int
    let nextEpisode: PodcastEpisode?
    let groups: [Group]
    let nextChange: Date?

    static func make(episodes: [PodcastEpisode], key: MacPodcastProjectionKey, now: Date = Date()) -> Self {
        let cutoff = now.addingTimeInterval(-7 * 86_400)
        var completedCount = 0
        var favoriteCount = 0
        var recent: [PodcastEpisode] = []
        var older: [PodcastEpisode] = []
        var nextChange: Date?
        for episode in episodes {
            if Task.isCancelled { break }
            let favorite = key.favoriteIDs.map { $0.contains(episode.id) || $0.contains("podcast_ep_\(episode.id)") } ?? episode.loved
            if episode.completed { completedCount += 1 }
            if favorite { favoriteCount += 1 }
            let included: Bool
            switch key.filter {
            case "unplayed": included = !episode.completed
            case "completed": included = episode.completed
            case "favorite": included = favorite
            default: included = true
            }
            guard included else { continue }
            if let date = macPodcastParsedDate(episode.pubDate), date >= cutoff {
                recent.append(episode)
                let change = date.addingTimeInterval(7 * 86_400)
                if nextChange == nil || change < nextChange! { nextChange = change }
            } else {
                older.append(episode)
            }
        }
        if !key.newestFirst { recent.reverse(); older.reverse() }
        let groups: [Group]
        if !recent.isEmpty && !older.isEmpty {
            let recentGroup = Group(heading: .recent, episodes: recent)
            let olderGroup = Group(heading: .older, episodes: older)
            groups = key.newestFirst ? [recentGroup, olderGroup] : [olderGroup, recentGroup]
        } else if !recent.isEmpty {
            groups = [Group(heading: .recent, episodes: recent)]
        } else if !older.isEmpty {
            groups = [Group(heading: .none, episodes: older)]
        } else {
            groups = []
        }
        let next = episodes.filter { $0.positionSeconds > 0 && !$0.completed }
            .max { ($0.lastListenedAt ?? "") < ($1.lastListenedAt ?? "") }
            ?? episodes.first { !$0.completed }
        return Self(key: key, completedCount: completedCount, favoriteCount: favoriteCount,
                    nextEpisode: next, groups: groups, nextChange: nextChange)
    }
}
