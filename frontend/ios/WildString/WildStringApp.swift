import SwiftUI

@main
struct WildStringApp: App {
    var body: some Scene {
        WindowGroup {
            PlaceholderRootView()
        }
    }
}

struct PlaceholderRootView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("野弦", systemImage: "music.note")
            } description: {
                Text("iOS 客户端骨架已就位，连接页与曲库待实现。")
            }
            .navigationTitle("野弦")
        }
    }
}
