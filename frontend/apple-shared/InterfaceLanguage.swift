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

    static var current: InterfaceLanguage {
        InterfaceLanguage(preference: UserDefaults.standard.string(forKey: storageKey))
    }

    var label: LocalizedStringKey {
        switch self {
        case .auto: return "language.auto"
        case .zh: return "language.zh"
        case .en: return "language.en"
        }
    }

    var labelString: String {
        switch self {
        case .auto: return L10n("language.auto")
        case .zh: return L10n("language.zh")
        case .en: return L10n("language.en")
        }
    }

    /// Locale used for SwiftUI string lookup and formatting.
    var locale: Locale {
        switch self {
        case .zh: return Locale(identifier: "zh-Hans")
        case .en: return Locale(identifier: "en")
        case .auto:
            if isRunningTests {
                return Locale(identifier: "zh-Hans")
            }
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

/// Resolves a key from Localizable.xcstrings using the active `InterfaceLanguage`.
func L10n(_ key: String, _ args: CVarArg...) -> String {
    let lang = InterfaceLanguage.current.locale.identifier
    let template = resolveBundleString(key: key, lang: lang)
    guard !args.isEmpty else { return template }
    return String(format: template, locale: InterfaceLanguage.current.locale, arguments: args)
}

private func resolveBundleString(key: String, lang: String) -> String {
    let candidates = [Bundle.main] + Bundle.allBundles
    for base in candidates {
        if let path = base.path(forResource: lang, ofType: "lproj"),
           let lproj = Bundle(path: path)
        {
            let value = lproj.localizedString(forKey: key, value: "\u{0000}", table: nil)
            if value != "\u{0000}" { return value }
        }
    }
    let fallback = Bundle.main.localizedString(forKey: key, value: key, table: nil)
    return fallback
}

private var isRunningTests: Bool {
    if NSClassFromString("XCTestCase") != nil { return true }
    let info = ProcessInfo.processInfo
    if info.environment["XCTestConfigurationFilePath"] != nil { return true }
    let procName = info.processName.lowercased()
    if procName.contains("test") { return true }
    if info.arguments.contains(where: { $0.lowercased().contains("test") }) { return true }
    return false
}
