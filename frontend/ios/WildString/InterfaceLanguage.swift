import Foundation
import SwiftUI

/// Interface language preference ("auto" | "zh" | "en").
///
/// The value lives on the account (PUT /api/v1/auth/preferences) and is mirrored into
/// UserDefaults so the root view can apply it. "auto" follows the system language, and any
/// language other than Chinese falls back to English.
enum InterfaceLanguage: String, CaseIterable {
    case auto
    case zh
    case en

    static let storageKey = "interfaceLanguage"

    init(preference: String?) {
        self = InterfaceLanguage(rawValue: preference ?? "") ?? .auto
    }

    var label: LocalizedStringKey {
        switch self {
        case .auto: return "language.auto"
        case .zh: return "language.zh"
        case .en: return "language.en"
        }
    }

    /// Locale used for SwiftUI string lookup and formatting.
    var locale: Locale {
        switch self {
        case .zh: return Locale(identifier: "zh-Hans")
        case .en: return Locale(identifier: "en")
        case .auto:
            let system = Locale.preferredLanguages.first ?? "en"
            return Locale(identifier: system.lowercased().hasPrefix("zh") ? "zh-Hans" : "en")
        }
    }

    /// Mirrors the account value locally; `nil` (signed out or an older server) means auto.
    static func store(_ preference: String?) {
        let value = InterfaceLanguage(preference: preference)
        UserDefaults.standard.set(value.rawValue, forKey: storageKey)
        // SwiftUI views follow the environment locale immediately; AppleLanguages makes
        // Bundle lookups (String(localized:), system UI) match from the next launch.
        switch value {
        case .auto: UserDefaults.standard.removeObject(forKey: "AppleLanguages")
        case .zh: UserDefaults.standard.set(["zh-Hans"], forKey: "AppleLanguages")
        case .en: UserDefaults.standard.set(["en"], forKey: "AppleLanguages")
        }
    }
}
