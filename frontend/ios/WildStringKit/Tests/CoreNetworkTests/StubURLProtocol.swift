import Foundation

final class StubURLProtocol: URLProtocol {
    struct Stub {
        var statusCode: Int
        var headers: [String: String]
        var body: Data

        static func json(
            status: Int = 200,
            headers: [String: String] = [:],
            body: String
        ) -> Stub {
            Stub(statusCode: status, headers: headers, body: Data(body.utf8))
        }

        static func empty(status: Int = 204) -> Stub {
            Stub(statusCode: status, headers: [:], body: Data())
        }
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (@Sendable (URLRequest) throws -> Stub)?
    nonisolated(unsafe) private static var recorded: [URLRequest] = []

    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        return configuration
    }

    static func respond(_ handler: @escaping @Sendable (URLRequest) throws -> Stub) {
        lock.withLock {
            Self.handler = handler
            recorded = []
        }
    }

    static var requests: [URLRequest] {
        lock.withLock { recorded }
    }

    static func reset() {
        lock.withLock {
            handler = nil
            recorded = []
        }
    }

    static func bodyData(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let stubHandler = Self.lock.withLock { () -> (@Sendable (URLRequest) throws -> Stub)? in
            Self.recorded.append(request)
            return Self.handler
        }
        guard let stubHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        do {
            let stub = try stubHandler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: stub.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: stub.headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !stub.body.isEmpty {
                client?.urlProtocol(self, didLoad: stub.body)
            }
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
