import Foundation

public struct Lyrics: Decodable, Equatable, Sendable {
    public let kind: String
    public let source: String?
    public let lines: [LyricLine]

    public init(kind: String, source: String? = nil, lines: [LyricLine]) {
        self.kind = kind
        self.source = source
        self.lines = lines
    }

    public var isSynced: Bool { kind == "synced" }

    public var isEmpty: Bool {
        kind == "none"
            || lines.allSatisfy { $0.text.trimmingCharacters(in: .whitespaces).isEmpty }
    }
}

public struct LyricLine: Decodable, Equatable, Sendable {
    public let timeMs: Int64?
    public let text: String

    public init(timeMs: Int64?, text: String) {
        self.timeMs = timeMs
        self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case text
        case timeMs = "time_ms"
    }
}

extension WildstringClient {
    /// `GET /api/v1/tracks/{id}/lyrics`; kind is synced, plain or none.
    public func lyrics(trackID: String) async throws -> Lyrics {
        let data = try await perform(
            Request(method: "GET", path: "api/v1/tracks/\(trackID)/lyrics")
        )
        return try JSONDecoder().decode(Lyrics.self, from: data)
    }
}
