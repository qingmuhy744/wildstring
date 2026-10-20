import SwiftUI

private struct IsAdminKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var isAdmin: Bool {
        get { self[IsAdminKey.self] }
        set { self[IsAdminKey.self] = newValue }
    }
}

enum AdminDestination: Hashable {
    case scans
    case imports
}
