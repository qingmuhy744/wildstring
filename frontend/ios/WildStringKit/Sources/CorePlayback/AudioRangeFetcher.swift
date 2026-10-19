import CoreNetwork
import Foundation

/// Fetches authenticated byte ranges for AVPlayer pass-through streaming.
public struct AudioRangeFetcher: Sendable {
    public struct Chunk: Sendable {
        public var data: Data
        public var totalLength: Int64?
        public var contentType: String?
    }

    public struct Probe: Sendable {
        public var totalLength: Int64?
        public var contentType: String?
    }

    private let server: ServerAddress
    private let session: URLSession
    private let cookieHeader: @Sendable () async -> String?

    public init(
        server: ServerAddress,
        cookieHeader: @escaping @Sendable () async -> String?,
        configuration: URLSessionConfiguration? = nil
    ) {
        self.server = server
        self.cookieHeader = cookieHeader
        self.session = URLSession(configuration: configuration ?? Self.defaultConfiguration())
    }

    public func probe(path: String) async throws -> Probe {
        let (_, response) = try await send(path: path, method: "HEAD", range: nil)
        return Probe(
            totalLength: Self.contentLength(of: response),
            contentType: response.value(forHTTPHeaderField: "Content-Type")
        )
    }

    public func fetch(path: String, offset: Int64, length: Int64) async throws -> Chunk {
        let range: String
        if length <= 0 || length == Int64.max {
            range = "bytes=\(offset)-"
        } else {
            range = "bytes=\(offset)-\(offset + length - 1)"
        }
        let (data, response) = try await send(path: path, method: "GET", range: range)
        var body = data
        if length > 0, length != Int64.max, Int64(body.count) > length {
            body = body.prefix(Int(length))
        }
        return Chunk(
            data: body,
            totalLength: Self.totalLength(of: response),
            contentType: response.value(forHTTPHeaderField: "Content-Type")
        )
    }

    private func send(
        path: String,
        method: String,
        range: String?
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: server.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 60
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        if let range {
            request.setValue(range, forHTTPHeaderField: "Range")
        }
        if let cookie = await cookieHeader() {
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            let code =
                (try? JSONDecoder().decode(ErrorEnvelope.self, from: data))?.detail
                ?? "http_\(http.statusCode)"
            throw APIError(statusCode: http.statusCode, code: code)
        }
        return (data, http)
    }

    private struct ErrorEnvelope: Decodable {
        let detail: String
    }

    private static func defaultConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 60
        return configuration
    }

    static func totalLength(of response: HTTPURLResponse) -> Int64? {
        if let range = response.value(forHTTPHeaderField: "Content-Range"),
            let total = range.split(separator: "/").last,
            total != "*",
            let value = Int64(total)
        {
            return value
        }
        return contentLength(of: response)
    }

    static func contentLength(of response: HTTPURLResponse) -> Int64? {
        if let raw = response.value(forHTTPHeaderField: "Content-Length"),
            let value = Int64(raw), value >= 0
        {
            return value
        }
        let expected = response.expectedContentLength
        return expected >= 0 ? expected : nil
    }
}
