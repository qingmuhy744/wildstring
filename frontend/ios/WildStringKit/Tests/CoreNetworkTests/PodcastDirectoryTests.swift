import Foundation
import Testing
@testable import CoreNetwork

extension StubbedHTTPTests {
    @Suite("Podcast directory")
    struct PodcastDirectorySuite {
        private func client() throws -> WildstringClient {
            WildstringClient(server: try ServerAddress(input: "music.example.com"),
                store: InMemorySessionStore(), configuration: StubURLProtocol.configuration())
        }

        @Test func exploreAndSearchUseSeparateReadOnlyEndpoints() async throws {
            StubURLProtocol.respond { request in
                #expect(request.httpMethod == "GET")
                let url = try #require(request.url)
                let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
                if url.path.hasSuffix("/discover") {
                    #expect(query == [URLQueryItem(name: "region", value: "tw")])
                } else {
                    #expect(url.path == "/api/v1/podcasts/search")
                    #expect(query == [URLQueryItem(name: "q", value: "声音")])
                }
                return .json(body: #"{"results":[{"itunes_id":"12345","title":"探索节目","author":"测试工作室","feed_url":"https://podcast.example/feed.xml","artwork_url":"","genres":[],"explicit":false,"followed":false,"catalog_podcast_id":null}],"regions":["tw"],"failed_regions":[],"explicit_hidden":0}"#)
            }
            let api = try client()
            let explore = try await api.podcastDirectory(query: "", region: "tw")
            #expect(explore.results.first?.itunesID == "12345")
            #expect(explore.results.first?.catalogPodcastID == nil)
            _ = try await api.podcastDirectory(query: "声音", region: "tw")
            #expect(StubURLProtocol.requests.count == 2)
        }

        @Test func previewDoesNotAddAndConfirmationSendsVerifiedIdentity() async throws {
            StubURLProtocol.respond { request in
                let path = request.url!.path
                if path.hasSuffix("/catalog-settings") {
                    #expect(request.httpMethod == "GET")
                    return .json(body: #"{"can_add":false}"#)
                }
                #expect(request.httpMethod == "POST")
                let data = try #require(StubURLProtocol.bodyData(of: request))
                let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: String])
                #expect(body["feed_url"] == "https://podcast.example/feed.xml")
                if path.hasSuffix("/preview") {
                    #expect(body["itunes_id"] == nil)
                    return .json(body: #"{"title":"探索节目","author":"测试工作室","description":"简介","episode_count":1,"latest_episodes":[{"title":"单集","pub_date":null}],"followed":false,"catalog_podcast_id":null}"#)
                }
                #expect(path == "/api/v1/podcasts")
                #expect(body["itunes_id"] == "12345")
                return .json(body: #"{"podcast":{"id":"p1","title":"探索节目","followed":true},"episodes":[]}"#)
            }
            let api = try client()
            #expect(try await !api.canAddPodcasts())
            let preview = try await api.previewPodcast(feedURL: "https://podcast.example/feed.xml")
            #expect(preview.latestEpisodes.first?.pubDate == nil)
            #expect(StubURLProtocol.requests.allSatisfy { $0.url?.path != "/api/v1/podcasts" })
            let added = try await api.addPodcast(feedURL: "https://podcast.example/feed.xml", itunesID: "12345")
            #expect(added.podcast.id == "p1" && added.podcast.followed)
        }
    }
}
