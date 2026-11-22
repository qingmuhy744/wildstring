import SwiftUI

private struct IsAdminKey: EnvironmentKey {
    static let defaultValue = false
}

private struct CanManageLibraryKey: EnvironmentKey {
    static let defaultValue = false
}

private struct CanEditMetadataKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var canManageLibrary: Bool {
        get { self[CanManageLibraryKey.self] }
        set { self[CanManageLibraryKey.self] = newValue }
    }

    var canEditMetadata: Bool {
        get { self[CanEditMetadataKey.self] }
        set { self[CanEditMetadataKey.self] = newValue }
    }

    var isAdmin: Bool {
        get { self[IsAdminKey.self] }
        set { self[IsAdminKey.self] = newValue }
    }
}

enum AdminDestination: Hashable {
    case scans
    case imports
}
