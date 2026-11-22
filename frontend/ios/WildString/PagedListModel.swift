import CoreNetwork
import CorePlayback
import Foundation
import Observation

/// Paged, infinitely scrolling list state for library screens.
@MainActor
@Observable
final class PagedListModel<Element: Decodable & Identifiable & Sendable> {
    private(set) var items: [Element] = []
    private(set) var total = 0
    private(set) var isLoading = false
    private(set) var didLoadOnce = false
    private(set) var errorMessage: String?

    private let pageSize: Int
    private let fetchPage: (Int, Int) async throws -> Page<Element>
    private var nextOffset = 0
    private var windowOffset = 0
    private var revision = 0

    init(pageSize: Int = 100, fetchPage: @escaping (Int, Int) async throws -> Page<Element>) {
        self.pageSize = pageSize
        self.fetchPage = fetchPage
    }

    var canLoadMore: Bool { items.count < total }

    func loadInitial() async {
        revision += 1
        items = []
        total = 0
        nextOffset = 0
        windowOffset = 0
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
            nextOffset += page.items.count
            total = page.total
            didLoadOnce = true
            errorMessage = nil
        } catch {
            errorMessage = ErrorText.message(for: error)
            didLoadOnce = true
        }
    }

    /// Replaces the loaded window with the page at the given offset (alphabet jump).
    func jump(toOffset offset: Int) async {
        guard !isLoading else { return }
        revision += 1
        isLoading = true
        defer { isLoading = false }
        do {
            let start = max(0, offset)
            let page = try await fetchPage(pageSize, start)
            items = page.items
            windowOffset = start
            nextOffset = start + page.items.count
            total = page.total
            didLoadOnce = true
            errorMessage = nil
        } catch {
            errorMessage = ErrorText.message(for: error)
            didLoadOnce = true
        }
    }

    func allItems() async throws -> [Element] {
        var offset = 0
        var result: [Element] = []
        while true {
            try Task.checkCancellation()
            let page = try await fetchPage(pageSize, offset)
            result.append(contentsOf: page.items)
            offset += page.items.count
            if page.items.isEmpty || offset >= page.total { return result }
        }
    }

    func play(_ track: Track, using playback: PlaybackService) where Element == Track {
        guard let index = items.firstIndex(where: { $0.id == track.id }) else { return }
        let token = playback.beginMusicSelection()
        let selectionRevision = revision
        let sourceTotal = total
        let absolute = windowOffset + index
        guard absolute < sourceTotal else { errorMessage = L10n("playback.collectionChanged"); return }
        let start = sourceTotal > PlaybackService.musicQueueLimit ? absolute : 0
        let count = min(PlaybackService.musicQueueLimit, sourceTotal - start)
        guard count > 0 else { return }
        Task {
            do {
                let tracks: [Track]
                if start >= windowOffset, start + count <= windowOffset + items.count {
                    tracks = Array(items[(start - windowOffset)..<(start - windowOffset + count)])
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
                guard tracks[absolute - start].id == track.id else { errorMessage = L10n("playback.collectionChanged"); return }
                playback.play(items: tracks.map(\.playbackItem), startingAt: absolute - start, sourceCount: sourceTotal)
            } catch {
                guard playback.isCurrentMusicSelection(token) else { return }
                errorMessage = ErrorText.message(for: error)
            }
        }
    }

    /// Applies a local drag reorder before the server confirms it.
    func applyReorder(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        items.move(fromOffsets: offsets, toOffset: destination)
    }
}
