import CoreNetwork
import Foundation
import Testing
@testable import CorePlayback

@Test func offlineBatchCountsOnlyActualNewOrRestoredDownloadsBeforeWriting() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    func savedItem(_ id: String, state: String) -> OfflineDownloads.Item {
        OfflineDownloads.Item(
            trackID: id, title: id, artist: "", fileName: "\(id).audio",
            receivedBytes: 0, expectedBytes: 0, sizeBytes: 0, state: state
        )
    }

    let index = OfflineDownloads.Index(items: [
        "0": savedItem("0", state: "completed"),
        "1": savedItem("1", state: "downloading"),
        "2": savedItem("2", state: "failed")
    ])
    let before = try JSONEncoder().encode(index)
    let indexURL = directory.appendingPathComponent("index.json")
    try before.write(to: indexURL)

    let downloads = OfflineDownloads(
        directory: directory, sessionIdentifier: UUID().uuidString,
        server: try ServerAddress(input: "https://fixture.invalid"), cookieHeader: { nil }
    )
    let tracks = (0...102).map { number in
        OfflineDownloads.TrackInfo(id: String(number), title: "Test", artist: "", streamPath: "fixture")
    }

    let result = try await downloads.downloadBatch(tracks + [tracks[2], tracks[3]], confirmed: false)
    #expect(result == .confirmationRequired(101))
    #expect(try Data(contentsOf: indexURL) == before)
    #expect(await downloads.items().count == 3)
}
