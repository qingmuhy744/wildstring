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
    public let words: [LyricWord]?
    public let translation: String?
    public let romanization: String?

    public init(timeMs: Int64?, text: String, words: [LyricWord]? = nil, translation: String? = nil, romanization: String? = nil) {
        self.timeMs = timeMs
        self.text = text
        self.words = words
        self.translation = translation
        self.romanization = romanization
    }

    enum CodingKeys: String, CodingKey {
        case text, words, translation, romanization
        case timeMs = "time_ms"
    }
}

public struct LyricWord: Decodable, Equatable, Sendable {
    public let startMs: Int64
    public let endMs: Int64
    public let text: String

    public init(startMs: Int64, endMs: Int64, text: String) {
        self.startMs = startMs
        self.endMs = endMs
        self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case startMs = "start_ms"
        case endMs = "end_ms"
        case text
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
