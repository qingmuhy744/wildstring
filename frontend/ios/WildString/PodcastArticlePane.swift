import CoreNetwork
import CorePlayback
import SwiftUI

@MainActor
struct PodcastArticlePane: View {
    let client: WildstringClient
    let playback: PlaybackService
    private enum Content {
        case loading, loaded(AttributedString), failed(String)
    }
    @State private var content = Content.loading

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(playback.currentItem?.title ?? "").font(.title2.bold())
                switch content {
                case .loading:
                    ProgressView(L10n("podcastArticle.loading"))
                case .loaded(let article):
                    if article.characters.isEmpty {
                        Text(L10n("podcasts.noDescription")).foregroundStyle(.secondary)
                    } else {
                        Text(article).textSelection(.enabled)
                    }
                case .failed(let message):
                    Text(message).foregroundStyle(.secondary)
                    Button(L10n("podcasts.retry")) { Task { await load() } }
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .task(id: playback.currentItem?.trackID) { await load() }
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == "wildstring-time", let seconds = Double(url.host ?? "") {
                playback.seek(to: seconds)
                return .handled
            }
            return ["http", "https"].contains(url.scheme) ? .systemAction : .discarded
        })
    }

    private func load() async {
        guard let id = playback.currentItem?.trackID, id.hasPrefix("podcast_ep_") else { return }
        content = .loading
        do {
            let episode = try await client.podcastEpisode(id: String(id.dropFirst("podcast_ep_".count)))
            let article = await Task.detached(priority: .userInitiated) {
                PodcastArticleText.render(episode.description, duration: episode.durationSeconds)
            }.value
            guard !Task.isCancelled, playback.currentItem?.trackID == id else { return }
            content = .loaded(article)
        } catch is CancellationError { return }
        catch {
            guard !Task.isCancelled, playback.currentItem?.trackID == id else { return }
            let key: String
            switch (error as? APIError)?.statusCode {
            case 401, 403: key = "podcastArticle.permission"
            case 404: key = "podcastArticle.missing"
            default: key = "podcastArticle.failed"
            }
            content = .failed(L10n(key))
        }
    }
}
