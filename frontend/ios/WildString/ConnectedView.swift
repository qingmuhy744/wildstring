import SwiftUI

@MainActor
struct ConnectedView: View {
    let server: String
    let username: String
    let onLogout: () -> Void

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("已连接", systemImage: "checkmark.circle")
            } description: {
                Text("\(username) · \(server)")
            } actions: {
                Button("退出登录", role: .destructive, action: onLogout)
            }
            .navigationTitle("野弦")
        }
    }
}
