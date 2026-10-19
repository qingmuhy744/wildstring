import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct MainTabView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let favorites: FavoritesModel
    let server: String
    let username: String
    var autoPlayFirst = false
    let onLogout: () -> Void

    @State private var selection: Int = Self.demoTab

    var body: some View {
        TabView(selection: $selection) {
            BrowseView(client: client, playback: playback, autoPlayFirst: autoPlayFirst)
                .tabItem { Label("曲库", systemImage: "music.note.list") }
                .tag(0)
            DailyRecommendationsView(client: client, playback: playback)
                .tabItem { Label("推荐", systemImage: "sparkles") }
                .tag(1)
            SearchView(client: client, playback: playback)
                .tabItem { Label("搜索", systemImage: "magnifyingglass") }
                .tag(2)
            AccountView(
                client: client,
                playback: playback,
                server: server,
                username: username,
                onLogout: onLogout
            )
            .tabItem { Label("我的", systemImage: "person.crop.circle") }
            .tag(3)
        }
        .environment(favorites)
        .task { await favorites.load() }
    }

    /// Debug-only hook used by the simulator verification runs.
    private static var demoTab: Int {
        #if DEBUG
            switch ProcessInfo.processInfo.environment["WILDSTRING_DEMO_TAB"] {
            case "recommendations": return 1
            case "search": return 2
            case "account": return 3
            default: return 0
            }
        #else
            return 0
        #endif
    }
}
