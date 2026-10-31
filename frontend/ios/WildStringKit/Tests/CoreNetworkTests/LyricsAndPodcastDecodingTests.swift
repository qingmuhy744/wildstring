import Foundation
import Testing
@testable import CoreNetwork

@Suite("Lyrics and podcast presentation data")
struct LyricsAndPodcastDecodingTests {
    @Test func wordLyricsDecodeAlongsideLegacyLines() throws {
        let data = Data(#"{"kind":"synced","lines":[{"time_ms":1000,"text":"甲乙","words":[{"start_ms":1000,"end_ms":1500,"text":"甲"},{"start_ms":1500,"end_ms":2500,"text":"乙"}],"translation":"A B","romanization":"jia yi"},{"time_ms":3000,"text":"普通行"}]}"#.utf8)
        let lyrics = try JSONDecoder().decode(Lyrics.self, from: data)
        #expect(lyrics.lines[0].words?.count == 2)
        #expect(lyrics.lines[0].words?[1] == LyricWord(startMs: 1500, endMs: 2500, text: "乙"))
        #expect(lyrics.lines[0].translation == "A B")
        #expect(lyrics.lines[0].romanization == "jia yi")
        #expect(lyrics.lines[1].words == nil)
        #expect(lyrics.lines[1].translation == nil)
    }

    @Test func podcastCoverDecodesAndMissingCoverRemainsSupported() throws {
        let covered = try JSONDecoder().decode(PodcastSummary.self,
            from: Data(#"{"id":"p1","title":"节目","cover_url":"https://example.com/art.jpg"}"#.utf8))
        #expect(covered.coverURL == URL(string: "https://example.com/art.jpg"))
        let legacy = try JSONDecoder().decode(PodcastSummary.self,
            from: Data(#"{"id":"p1","title":"节目"}"#.utf8))
        #expect(legacy.coverURL == nil)
    }

    @Test(arguments: ["file:///tmp/art.jpg", "data:image/png;base64,AA", "javascript:alert(1)"])
    func podcastCoverRejectsNonNetworkURLs(_ url: String) throws {
        let data = try JSONEncoder().encode(["id": "p1", "title": "节目", "cover_url": url])
        let podcast = try JSONDecoder().decode(PodcastSummary.self, from: data)
        #expect(podcast.coverURL == nil)
    }
}
