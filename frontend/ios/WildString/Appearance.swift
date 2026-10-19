import SwiftUI
import UIKit

enum PlayerStyle: String, CaseIterable {
    case cover
    case vinyl
    case cassette

    var label: String {
        switch self {
        case .cover: return "封面"
        case .vinyl: return "黑胶"
        case .cassette: return "磁带"
        }
    }
}

enum SongListSize: String, CaseIterable {
    case small
    case medium
    case large

    var label: String {
        switch self {
        case .small: return "小"
        case .medium: return "中（推荐）"
        case .large: return "大"
        }
    }

    var coverSide: CGFloat {
        switch self {
        case .small: return 34
        case .medium: return 44
        case .large: return 56
        }
    }

    var titleFont: Font {
        switch self {
        case .small: return .caption
        case .medium: return .body
        case .large: return .title3
        }
    }
}

enum ThemeChoice: String, CaseIterable {
    case system
    case light
    case dark

    var label: String {
        switch self {
        case .system: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

enum Haptics {
    static var enabled: Bool {
        UserDefaults.standard.object(forKey: "hapticsEnabled") as? Bool ?? true
    }

    static func tap(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .light) {
        guard enabled else { return }
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }

    static func selection() {
        guard enabled else { return }
        UISelectionFeedbackGenerator().selectionChanged()
    }
}
