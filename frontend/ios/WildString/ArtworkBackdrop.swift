import CoreNetwork
import SwiftUI
import UIKit

/// Cover-colored blurred backdrop for the player, matching the Android
/// "封面氛围" treatment: blurred artwork, light tint, then a surface gradient
/// that keeps the content readable in both light and dark themes.
@MainActor
struct ArtworkBackdrop: View {
    let client: WildstringClient
    let trackID: String?

    @State private var image: UIImage?

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Color(.systemBackground)
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: proxy.size.width, height: proxy.size.height)
                        .clipped()
                        .blur(radius: 60, opaque: true)
                        .opacity(0.5)
                    LinearGradient(
                        colors: [
                            Color(.systemBackground).opacity(0.12),
                            Color(.systemBackground).opacity(0.55),
                            Color(.systemBackground).opacity(0.94),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                }
            }
            .ignoresSafeArea()
        }
        .task(id: trackID) { await load() }
    }

    private func load() async {
        guard let trackID, !trackID.isEmpty else {
            image = nil
            return
        }
        if let cached = CoverCache.shared.image(for: trackID) {
            image = cached
            return
        }
        image = nil
        if let data = try? await client.authorizedData(path: "api/v1/tracks/\(trackID)/cover"),
            let loaded = UIImage(data: data)
        {
            CoverCache.shared.store(loaded, for: trackID)
            image = loaded
        }
    }
}
