import CoreNetwork
import Foundation
import XCTest
@testable import WildString

@MainActor
final class PagedListModelTests: XCTestCase {
    func testRefreshDiscardsLatePageFromOlderLibraryList() async throws {
        let paging = PagingFixture()
        let model = PagedListModel<Track>(pageSize: 1) { _, offset in
            try await paging.page(Page<Track>.self, offset: offset)
        }
        await model.loadInitial()
        let more = Task { await model.loadMore() }
        await paging.waitForMore()
        await model.loadInitial()
        paging.finishMore()
        await more.value

        XCTAssertEqual(model.items.map(\.id), ["refreshed"])
        XCTAssertEqual(model.total, 2)
        XCTAssertFalse(model.isLoading)
    }

    func testRefreshDiscardsLatePageAndDiscSummariesFromOlderAlbumList() async throws {
        let paging = PagingFixture()
        let model = AlbumTracksModel(pageSize: 1) { _, offset in
            try await paging.page(AlbumTrackPage.self, offset: offset)
        }
        await model.loadInitial()
        let more = Task { await model.loadMore() }
        await paging.waitForMore()
        await model.loadInitial()
        paging.finishMore()
        await more.value

        XCTAssertEqual(model.items.map(\.id), ["refreshed"])
        XCTAssertEqual(model.discs.map(\.number), [2])
        XCTAssertFalse(model.isLoading)
    }
}

@MainActor
private final class PagingFixture {
    private var firstPages = 0
    private var moreStarted: CheckedContinuation<Void, Never>?
    private var moreResponse: CheckedContinuation<Void, Never>?

    func page<T: Decodable>(_ type: T.Type, offset: Int) async throws -> T {
        let id: String
        let disc: Int
        if offset == 0 {
            firstPages += 1
            id = firstPages == 1 ? "original" : "refreshed"
            disc = firstPages
        } else {
            await withCheckedContinuation { continuation in
                moreResponse = continuation
                moreStarted?.resume()
                moreStarted = nil
            }
            id = "late"
            disc = 9
        }
        let data = Data("""
            {"items":[{"id":"\(id)","title":"Track","artists":[],"duration_ms":1000,"has_cover":false}],
             "discs":[{"number":\(disc),"track_count":1,"duration_ms":1000,"offset":0}],
             "total":2,"limit":1,"offset":\(offset)}
            """.utf8)
        return try JSONDecoder().decode(type, from: data)
    }

    func waitForMore() async {
        if moreResponse != nil { return }
        await withCheckedContinuation { moreStarted = $0 }
    }

    func finishMore() {
        moreResponse?.resume()
        moreResponse = nil
    }
}
