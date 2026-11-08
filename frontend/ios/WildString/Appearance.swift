import SwiftUI
import UIKit

enum PlayerStyle: String, CaseIterable {
    case cover
    case vinyl
    case cassette

    var label: LocalizedStringKey {
        switch self {
        case .cover: return "playerStyle.cover"
        case .vinyl: return "playerStyle.vinyl"
        case .cassette: return "playerStyle.cassette"
        }
    }
}

enum SongListSize: String, CaseIterable {
    case small
    case medium
    case large

    var label: LocalizedStringKey {
        switch self {
        case .small: return "size.small"
        case .medium: return "size.mediumRecommended"
        case .large: return "size.large"
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

    var label: LocalizedStringKey {
        switch self {
        case .system: return "theme.system"
        case .light: return "theme.light"
        case .dark: return "theme.dark"
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

extension Color {
    /// 野弦暖橙，与 Android 主题的品牌主色一致。
    static let wildAccent = Color(red: 0.9137, green: 0.5412, blue: 0.4275)

    /// 播放器画布，暖纸/暖炭黑（DESIGN.md §3.1/§3.2 canvas），随系统浅深切换。
    static let playerCanvas = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.094, green: 0.086, blue: 0.078, alpha: 1)  // #181614
            : UIColor(red: 0.965, green: 0.953, blue: 0.929, alpha: 1)  // #F6F3ED
    })
}
