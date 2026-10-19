import CoreNetwork
import SwiftUI
import UIKit

@MainActor
final class CoverCache {
    static let shared = CoverCache()
    private let cache = NSCache<NSString, UIImage>()

    func image(for key: String) -> UIImage? {
        cache.object(forKey: key as NSString)
    }

    func store(_ image: UIImage, for key: String) {
        cache.setObject(image, forKey: key as NSString)
    }
}

/// Cover artwork loaded through the authenticated session, with a memory cache.
@MainActor
struct CoverImage: View {
    let client: WildstringClient
    let trackID: String?
    var size: CGFloat = 44
    var circular = false

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                ZStack {
                    Color(.secondarySystemFill)
                    Image(systemName: "music.note")
                        .font(.system(size: size * 0.32))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(circular ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: 6)))
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
        do {
            let data = try await client.authorizedData(path: "api/v1/tracks/\(trackID)/cover")
            guard let loaded = UIImage(data: data) else { return }
            CoverCache.shared.store(loaded, for: trackID)
            image = loaded
        } catch {
            // No artwork or unreachable; keep the placeholder.
        }
    }
}
