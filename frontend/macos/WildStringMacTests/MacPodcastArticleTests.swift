import Foundation
import Testing
@testable import WildString

@Suite("Podcast article")
struct MacPodcastArticleTests {
    @Test func displaysParagraphsWithoutExecutingHTMLOrLoadingImages() {
        let value = MacPodcastArticle.render(
            #"<p>First &amp; second</p><script>ignore()</script><style>hidden</style><img src="https://example.com/image"><p>Next<br>line</p>"#,
            duration: 100)
        #expect(String(value.characters) == "First & second\n\nNext\n\nline")
        #expect(value.runs.allSatisfy { $0.link == nil })
    }

    @Test func onlyValidChaptersBecomeSeekLinksAndURLPortsStayURLs() {
        let value = MacPodcastArticle.render(
            "[00:12] Intro\n[1:02:03] End\n[99:99] invalid\n99:00 out of bounds\nhttps://example.com:8080/path",
            duration: 4000)
        let links = value.runs.compactMap(\.link).map(\.absoluteString)
        #expect(links.contains("wildstring-time://12"))
        #expect(links.contains("wildstring-time://3723"))
        #expect(links.contains("https://example.com:8080/path"))
        #expect(links.count == 3)
    }

    @Test func keepsNamedLinksWithoutTurningUnsafeSchemesIntoActions() {
        let value = MacPodcastArticle.render(
            #"<p><a href="https://example.com/read?a=1&amp;b=2">延伸<b>阅读</b></a> / <a href='javascript:alert(1)'>普通文本</a></p>"#,
            duration: 100)
        #expect(String(value.characters) == "延伸阅读 / 普通文本")
        let links = value.runs.compactMap(\.link)
        #expect(links.map(\.absoluteString) == ["https://example.com/read?a=1&b=2"])
    }
}
