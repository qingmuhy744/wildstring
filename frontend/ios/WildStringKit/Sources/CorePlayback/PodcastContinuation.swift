import Foundation

/// Pure, client-side rule for podcast auto-continuation.
///
/// The contract keeps auto-continuation as a player policy: it never writes to
/// the "待播队列", is derived locally and is never synced. These functions take
/// plain values only, so every platform can be tested against the same vectors.
/// They know nothing about AVPlayer, shuffle or repeat modes.
public enum PodcastContinuation {
    /// One episode of a single show. `chronologicalIndex` is a stable rank
    /// where 0 is the oldest episode and larger values are newer; it is only
    /// consulted by `.oldestFirst` / `.newestFirst` ordering. The show detail
    /// is supplied newest-first, so callers build it with
    /// `episodes.count - 1 - arrayIndex`.
    public struct Episode: Sendable, Equatable, Identifiable {
        public var id: String
        public var title: String
        public var artist: String
        public var album: String?
        public var chronologicalIndex: Int
        public var isCompleted: Bool

        public init(
            id: String,
            title: String,
            artist: String = "电台",
            album: String? = nil,
            chronologicalIndex: Int,
            isCompleted: Bool = false
        ) {
            self.id = id
            self.title = title
            self.artist = artist
            self.album = album
            self.chronologicalIndex = chronologicalIndex
            self.isCompleted = isCompleted
        }
    }

    /// Direction the auto-continuation sequence follows. "跟随列表" uses the
    /// order the episodes were supplied in; the other two re-sort by
    /// `chronologicalIndex`. Turning auto-continue off is modelled by
    /// `Preference.autoContinue = false` (the contract's "关闭").
    public enum Order: String, Sendable {
        case follow
        case oldestFirst
        case newestFirst
    }

    public struct Preference: Sendable, Equatable {
        public var order: Order
        /// 默认跳过已听完.
        public var skipCompleted: Bool
        /// 关闭自动续播只停止预览与续播，保留手动队列.
        public var autoContinue: Bool

        public init(
            order: Order = .follow,
            skipCompleted: Bool = true,
            autoContinue: Bool = true
        ) {
            self.order = order
            self.skipCompleted = skipCompleted
            self.autoContinue = autoContinue
        }
    }

    /// Manual "上一集 / 下一集" direction.
    public enum Skip: Sendable {
        case previous
        case next
    }

    /// Returns the episode to play after `currentID`, or nil to stop.
    /// Bounded to the supplied show episodes (不跨节目合并), skips completed
    /// episodes by default and returns nil when auto-continue is off, when the
    /// current episode is not in the show, or when there is no candidate left.
    public static func nextEpisode(
        currentID: String,
        episodes: [Episode],
        preference: Preference
    ) -> Episode? {
        guard preference.autoContinue else { return nil }
        let ordered = ordered(episodes, by: preference.order)
        guard let current = ordered.firstIndex(where: { $0.id == currentID }) else {
            return nil
        }
        var index = current + 1
        while index < ordered.count {
            let candidate = ordered[index]
            if !preference.skipCompleted || !candidate.isCompleted {
                return candidate
            }
            index += 1
        }
        return nil
    }

    /// "上一集": the immediately preceding episode in the same order. Manual
    /// skips must work even when auto-continue is off, so this ignores
    /// `Preference.autoContinue`.
    public static func previousEpisode(
        currentID: String,
        episodes: [Episode],
        preference: Preference
    ) -> Episode? {
        let ordered = ordered(episodes, by: preference.order)
        guard let current = ordered.firstIndex(where: { $0.id == currentID }),
              current > 0 else { return nil }
        return ordered[current - 1]
    }

    private static func ordered(_ episodes: [Episode], by order: Order) -> [Episode] {
        switch order {
        case .follow:
            return episodes
        case .oldestFirst:
            return episodes.sorted { $0.chronologicalIndex < $1.chronologicalIndex }
        case .newestFirst:
            return episodes.sorted { $0.chronologicalIndex > $1.chronologicalIndex }
        }
    }
}
