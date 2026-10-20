import CoreNetwork
import Foundation
import Testing
@testable import CorePlayback

@Suite("AudioRangeFetcher", .serialized)
struct AudioRangeFetcherTests {
    private func makeFetcher(cookie: String? = "wildstring_session=token") throws
        -> AudioRangeFetcher
    {
        AudioRangeFetcher(
            server: try ServerAddress(input: "music.example.com"),
            cookieHeader: { cookie },
            configuration: StubURLProtocol.configuration()
        )
    }

    @Test func fetchSendsRangeAndCookie() async throws {
        StubURLProtocol.respond { request in
            #expect(request.httpMethod == "GET")
            #expect(request.url?.path == "/api/v1/tracks/t1/stream")
            #expect(request.value(forHTTPHeaderField: "Range") == "bytes=100-199")
            #expect(request.value(forHTTPHeaderField: "Cookie") == "wildstring_session=token")
            return .init(
                statusCode: 206,
                headers: [
                    "Content-Range": "bytes 100-199/500",
                    "Content-Type": "audio/mpeg",
                ],
                body: Data(repeating: 7, count: 100)
            )
        }
        let chunk = try await makeFetcher().fetch(
            path: "api/v1/tracks/t1/stream",
            offset: 100,
            length: 100
        )
        #expect(chunk.data.count == 100)
        #expect(chunk.totalLength == 500)
        #expect(chunk.contentType == "audio/mpeg")
    }

    @Test func fetchUsesOpenEndedRangeWhenLengthUnknown() async throws {
        StubURLProtocol.respond { request in
            #expect(request.value(forHTTPHeaderField: "Range") == "bytes=50-")
            return .init(statusCode: 206, headers: [:], body: Data(repeating: 1, count: 10))
        }
        _ = try await makeFetcher().fetch(
            path: "api/v1/tracks/t1/stream",
            offset: 50,
            length: .max
        )
    }

    @Test func fetchTrimsBytesBeyondRequestedRange() async throws {
        StubURLProtocol.respond { _ in
            .init(
                statusCode: 200,
                headers: ["Content-Length": "300"],
                body: Data(repeating: 1, count: 300)
            )
        }
        let chunk = try await makeFetcher().fetch(
            path: "api/v1/tracks/t1/stream",
            offset: 0,
            length: 100
        )
        #expect(chunk.data.count == 100)
        #expect(chunk.totalLength == 300)
    }

    @Test func probeReturnsLengthAndType() async throws {
        StubURLProtocol.respond { request in
            #expect(request.httpMethod == "HEAD")
            return .init(
                statusCode: 200,
                headers: ["Content-Length": "12345", "Content-Type": "audio/flac"],
                body: Data()
            )
        }
        let probe = try await makeFetcher().probe(path: "api/v1/tracks/t1/stream")
        #expect(probe.totalLength == 12345)
        #expect(probe.contentType == "audio/flac")
    }

    @Test func fetchSurfacesStableServerCode() async throws {
        StubURLProtocol.respond { _ in
            .json(status: 401, body: #"{"detail":"authentication_required"}"#)
        }
        await #expect(throws: APIError(statusCode: 401, code: "authentication_required")) {
            try await makeFetcher().fetch(
                path: "api/v1/tracks/t1/stream",
                offset: 0,
                length: 100
            )
        }
    }
}
