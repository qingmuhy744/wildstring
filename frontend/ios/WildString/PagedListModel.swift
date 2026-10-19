import CoreNetwork
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

    init(pageSize: Int = 100, fetchPage: @escaping (Int, Int) async throws -> Page<Element>) {
        self.pageSize = pageSize
        self.fetchPage = fetchPage
    }

    var canLoadMore: Bool { items.count < total }

    func loadInitial() async {
        items = []
        total = 0
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
            let page = try await fetchPage(pageSize, items.count)
            var seen = Set(items.map(\.id))
            for item in page.items where seen.insert(item.id).inserted {
                items.append(item)
            }
            total = page.total
            didLoadOnce = true
            errorMessage = nil
        } catch {
            errorMessage = ErrorText.message(for: error)
            didLoadOnce = true
        }
    }
}
