import Foundation
import Security

public struct StoredCookie: Codable, Equatable, Sendable {
    public var name: String
    public var value: String
    public var domain: String
    public var path: String
    public var expiresAt: Date?
    public var isSecure: Bool

    public init(
        name: String,
        value: String,
        domain: String,
        path: String,
        expiresAt: Date? = nil,
        isSecure: Bool = false
    ) {
        self.name = name
        self.value = value
        self.domain = domain
        self.path = path
        self.expiresAt = expiresAt
        self.isSecure = isSecure
    }
}

public struct StoredSession: Codable, Equatable, Sendable {
    public var cookies: [StoredCookie]

    public init(cookies: [StoredCookie]) {
        self.cookies = cookies
    }
}

/// Persists session cookies per server origin.
public protocol SessionStore: Sendable {
    func loadSession(origin: String) throws -> StoredSession?
    func saveSession(_ session: StoredSession, origin: String) throws
    func clearSession(origin: String) throws
}

public final class InMemorySessionStore: SessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var sessions: [String: StoredSession] = [:]

    public init() {}

    public func loadSession(origin: String) throws -> StoredSession? {
        lock.withLock { sessions[origin] }
    }

    public func saveSession(_ session: StoredSession, origin: String) throws {
        lock.withLock { sessions[origin] = session }
    }

    public func clearSession(origin: String) throws {
        _ = lock.withLock { sessions.removeValue(forKey: origin) }
    }
}

public struct KeychainError: Error, Equatable, Sendable {
    public let status: OSStatus

    public init(status: OSStatus) {
        self.status = status
    }
}

/// Stores session cookies in the Keychain, encrypted by the system.
public final class KeychainSessionStore: SessionStore, @unchecked Sendable {
    private let service: String

    public init(service: String = "com.wildstring.app.session") {
        self.service = service
    }

    public func loadSession(origin: String) throws -> StoredSession? {
        var query = baseQuery(origin: origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw KeychainError(status: status)
        }
        return try JSONDecoder().decode(StoredSession.self, from: data)
    }

    public func saveSession(_ session: StoredSession, origin: String) throws {
        let data = try JSONEncoder().encode(session)
        SecItemDelete(baseQuery(origin: origin) as CFDictionary)
        var query = baseQuery(origin: origin)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func clearSession(origin: String) throws {
        let status = SecItemDelete(baseQuery(origin: origin) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }

    private func baseQuery(origin: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: origin,
        ]
    }
}
