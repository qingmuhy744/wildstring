import Foundation

/// A validated, normalized address of a WildString server.
public struct ServerAddress: Hashable, Sendable, CustomStringConvertible {
    public enum ValidationError: Error, Equatable, Sendable {
        case invalidURL
        case unsupportedScheme
        case insecureHTTPNotAllowed
    }

    public let url: URL
    /// Stable storage key: scheme://host[:port], without the base path.
    public let origin: String

    public init(input: String, allowsInsecureHTTP: Bool = false) throws {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ValidationError.invalidURL }
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let components = URLComponents(string: candidate) else {
            throw ValidationError.invalidURL
        }
        guard components.query == nil, components.fragment == nil,
            components.user == nil, components.password == nil
        else {
            throw ValidationError.invalidURL
        }
        let scheme = (components.scheme ?? "").lowercased()
        guard scheme == "http" || scheme == "https" else {
            throw ValidationError.unsupportedScheme
        }
        guard let rawHost = components.host, !rawHost.isEmpty else {
            throw ValidationError.invalidURL
        }
        let host = rawHost.lowercased()
        var port = components.port
        if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) {
            port = nil
        }
        if scheme == "http" {
            guard allowsInsecureHTTP else {
                throw ValidationError.insecureHTTPNotAllowed
            }
        }
        var path = components.path
        if path == "/" { path = "" }
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }

        var normalized = URLComponents()
        normalized.scheme = scheme
        normalized.host = host
        normalized.port = port
        normalized.path = path
        guard let url = normalized.url else { throw ValidationError.invalidURL }
        self.url = url

        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = port
        guard let originString = origin.string else { throw ValidationError.invalidURL }
        self.origin = originString
    }

    /// Absolute URL for an API path, preserving any configured base path.
    public func appending(path: String) -> URL {
        var base = url.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        let suffix = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: base + "/" + suffix) ?? url
    }

    public var description: String { url.absoluteString }
}
