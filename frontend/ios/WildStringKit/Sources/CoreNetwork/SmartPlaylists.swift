import Foundation

/// Server-side smart playlist definition (bounded Navidrome-style rule subset).
/// Matches the JSON schema accepted by POST/PUT /api/v1/playlists.
public enum SmartValue: Encodable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case numbers([Double])

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let string):
            try container.encode(string)
        case .number(let number):
            try container.encode(number)
        case .bool(let bool):
            try container.encode(bool)
        case .numbers(let numbers):
            try container.encode(numbers)
        }
    }
}

public struct SmartRule: Encodable, Equatable, Sendable {
    public let `operator`: String
    public let field: String
    public let value: SmartValue

    public init(operator: String, field: String, value: SmartValue) {
        self.operator = `operator`
        self.field = field
        self.value = value
    }

    public func encode(to encoder: Encoder) throws {
        var outer = encoder.container(keyedBy: AnyCodingKey.self)
        var inner = outer.nestedContainer(keyedBy: AnyCodingKey.self, forKey: AnyCodingKey(self.operator))
        try inner.encode(value, forKey: AnyCodingKey(field))
    }
}

public struct SmartDefinition: Encodable, Equatable, Sendable {
    /// "all" (AND) or "any" (OR).
    public let match: String
    public let rules: [SmartRule]
    public let sort: String
    public let order: String
    public let limit: Int

    public init(match: String, rules: [SmartRule], sort: String, order: String, limit: Int) {
        self.match = match == "any" ? "any" : "all"
        self.rules = rules
        self.sort = sort
        self.order = order
        self.limit = limit
    }

    public func encode(to encoder: Encoder) throws {
        var outer = encoder.container(keyedBy: AnyCodingKey.self)
        try outer.encode(rules, forKey: AnyCodingKey(match == "any" ? "any" : "all"))
        try outer.encode(sort, forKey: AnyCodingKey("sort"))
        try outer.encode(order, forKey: AnyCodingKey("order"))
        try outer.encode(limit, forKey: AnyCodingKey("limit"))
    }
}

struct AnyCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }

    init(_ stringValue: String) {
        self.stringValue = stringValue
    }

    init?(stringValue: String) {
        self.init(stringValue)
    }

    init?(intValue: Int) {
        return nil
    }
}
