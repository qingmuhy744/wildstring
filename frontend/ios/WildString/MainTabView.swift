import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct MainTabView: View {
    let client: WildstringClient
    let playback: PlaybackService
    let server: String
    let username: String
    var autoPlayFirst = false
    let onLogout: () -> Void

    var body: some View {
        TabView {
            BrowseView(client: client, playback: playback, autoPlayFirst: autoPlayFirst)
                .tabItem { Label("曲库", systemImage: "music.note.list") }
            SearchView(client: client, playback: playback)
                .tabItem { Label("搜索", systemImage: "magnifyingglass") }
            AccountView(
                server: server,
                username: username,
                playback: playback,
                onLogout: onLogout
            )
            .tabItem { Label("我的", systemImage: "person.crop.circle") }
        }
    }
}
