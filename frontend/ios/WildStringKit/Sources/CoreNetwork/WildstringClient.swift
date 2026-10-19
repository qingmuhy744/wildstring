import Foundation

public struct APIError: Error, Equatable, Sendable {
    public let statusCode: Int
    public let code: String

    public init(statusCode: Int, code: String) {
        self.statusCode = statusCode
        self.code = code
    }
}

public struct User: Decodable, Equatable, Sendable {
    public let id: String
    public let username: String
    public let role: String
    public let version: Int
    public let enabled: Bool
}

public struct AuthStatus: Decodable, Equatable, Sendable {
    public let configured: Bool
    public let authenticated: Bool
    public let user: User?
}

/// HTTP client for one WildString server. Cookie sessions are kept per origin in the given store.
public final class WildstringClient: Sendable {
    public let server: ServerAddress

    private let session: URLSession
    private let cookies: CookieJar

    public init(
        server: ServerAddress,
        store: any SessionStore,
        configuration: URLSessionConfiguration? = nil
    ) {
        self.server = server
        let configuration = configuration ?? Self.defaultConfiguration()
        let delegate = NoRedirectDelegate()
        self.session = URLSession(
            configuration: configuration,
            delegate: delegate,
            delegateQueue: nil
        )
        self.cookies = CookieJar(store: store, origin: server.origin)
    }

    public func authStatus() async throws -> AuthStatus {
        let data = try await perform(
            Request(
                method: "GET",
                path: "api/v1/auth/status",
                clearsSessionOnUnauthorized: false
            )
        )
        return try JSONDecoder().decode(AuthStatus.self, from: data)
    }

    public func login(username: String, password: String) async throws -> User {
        struct Credentials: Encodable {
            let username: String
            let password: String
        }
        let body = try JSONEncoder().encode(
            Credentials(username: username, password: password)
        )
        let data = try await perform(
            Request(
                method: "POST",
                path: "api/v1/auth/login",
                body: body,
                contentType: "application/json",
                clearsSessionOnUnauthorized: false
            )
        )
        return try JSONDecoder().decode(User.self, from: data)
    }

    public func logout() async throws {
        _ = try await perform(
            Request(
                method: "POST",
                path: "api/v1/auth/logout",
                clearsSessionOnUnauthorized: false
            )
        )
        try await cookies.clear()
    }

    /// Whether a session cookie is stored locally; the server may still reject it.
    public func storedSessionExists() async -> Bool {
        (try? await cookies.headerValue()) != nil
    }

    /// Cookie header value for auxiliary requests such as AVPlayer asset loading.
    public func cookieHeaderValue() async -> String? {
        try? await cookies.headerValue()
    }

    public func clearSession() async {
        try? await cookies.clear()
    }

    private static func defaultConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        return configuration
    }

    struct Request {
        var method: String
        var path: String
        var body: Data?
        var contentType: String?
        var queryItems: [URLQueryItem] = []
        var timeout: TimeInterval?
        var clientHeader = "ios"
        var clearsSessionOnUnauthorized = true
    }

    private struct ErrorEnvelope: Decodable {
        let detail: String
    }

    func perform(_ request: Request) async throws -> Data {
        var attempt = request
        while true {
            let (data, response) = try await send(attempt)
            if (200..<300).contains(response.statusCode) {
                try await cookies.storeCookies(from: response, url: response.url ?? server.url)
                return data
            }
            let code =
                (try? JSONDecoder().decode(ErrorEnvelope.self, from: data))?.detail
                ?? "http_\(response.statusCode)"
            if response.statusCode == 403, code == "client_header_required",
                attempt.clientHeader != "web"
            {
                attempt.clientHeader = "web"
                continue
            }
            if response.statusCode == 401, attempt.clearsSessionOnUnauthorized {
                try? await cookies.clear()
            }
            throw APIError(statusCode: response.statusCode, code: code)
        }
    }

    private func send(_ request: Request) async throws -> (Data, HTTPURLResponse) {
        var url = server.appending(path: request.path)
        if !request.queryItems.isEmpty,
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        {
            components.queryItems = request.queryItems
            if let built = components.url { url = built }
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        urlRequest.timeoutInterval = request.timeout ?? 20
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if let contentType = request.contentType {
            urlRequest.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        urlRequest.setValue(request.clientHeader, forHTTPHeaderField: "X-Wildstring-Client")
        if let cookieHeader = try await cookies.headerValue() {
            urlRequest.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

private actor CookieJar {
    private let store: any SessionStore
    private let origin: String
    private var cached: [StoredCookie]?

    init(store: any SessionStore, origin: String) {
        self.store = store
        self.origin = origin
    }

    func headerValue(now: Date = .now) throws -> String? {
        let active = try current().filter { cookie in
            guard let expiresAt = cookie.expiresAt else { return true }
            return expiresAt > now
        }
        guard !active.isEmpty else { return nil }
        return active.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    }

    func storeCookies(from response: HTTPURLResponse, url: URL) throws {
        guard let header = response.value(forHTTPHeaderField: "Set-Cookie") else { return }
        let httpCookies = HTTPCookie.cookies(
            withResponseHeaderFields: ["Set-Cookie": header],
            for: url
        )
        guard !httpCookies.isEmpty else { return }
        var updated = try current()
        for httpCookie in httpCookies {
            let path = httpCookie.path.isEmpty ? "/" : httpCookie.path
            updated.removeAll {
                $0.name == httpCookie.name && $0.domain == httpCookie.domain
                    && $0.path == path
            }
            if let expiresAt = httpCookie.expiresDate, expiresAt <= Date() { continue }
            updated.append(
                StoredCookie(
                    name: httpCookie.name,
                    value: httpCookie.value,
                    domain: httpCookie.domain,
                    path: path,
                    expiresAt: httpCookie.expiresDate,
                    isSecure: httpCookie.isSecure
                )
            )
        }
        cached = updated
        if updated.isEmpty {
            try store.clearSession(origin: origin)
        } else {
            try store.saveSession(StoredSession(cookies: updated), origin: origin)
        }
    }

    func clear() throws {
        cached = []
        try store.clearSession(origin: origin)
    }

    private func current() throws -> [StoredCookie] {
        if let cached { return cached }
        let loaded = (try store.loadSession(origin: origin))?.cookies ?? []
        cached = loaded
        return loaded
    }
}
