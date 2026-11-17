import Foundation
import SwiftUI

/// Display RSS as text, without a web view, scripts, images or automatic network requests.
enum PodcastArticleText {
    static func render(_ raw: String, duration: Int) -> AttributedString {
        var text = raw.replacingOccurrences(of: #"(?is)<(script|style)\b[^>]*>.*?</\1\s*>"#, with: "", options: .regularExpression)
        // Keep named RSS links while rendering the remaining markup as plain text.
        let anchors = try! NSRegularExpression(pattern: #"(?is)<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>(.*?)</a\s*>"#)
        var destinations: [URL] = []
        for match in anchors.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            let source = text as NSString
            let href = source.substring(with: match.range(at: 2)).replacingOccurrences(of: "&amp;", with: "&")
            guard let url = URL(string: href), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  let range = Range(match.range, in: text) else { continue }
            let label = source.substring(with: match.range(at: 3))
            text.replaceSubrange(range, with: "\u{E000}\(destinations.count)\u{E001}\(label)\u{E002}")
            destinations.append(url)
        }
        text = text.replacingOccurrences(of: #"(?i)<br\s*/?>|</(?:p|div|h[1-6]|li|blockquote)\s*>"#, with: "\n\n", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?i)<li\b[^>]*>"#, with: "• ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"<[^>]*>"#, with: "", options: .regularExpression)
        for (entity, value) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&")] {
            text = text.replacingOccurrences(of: entity, with: value)
        }
        text = text.replacingOccurrences(of: #"\n[ \t]*\n(?:[ \t]*\n)+"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var rich = AttributedString()
        let marked = try! NSRegularExpression(pattern: "\u{E000}(\\d+)\u{E001}([\\s\\S]*?)\u{E002}")
        let source = text as NSString
        var cursor = 0
        for match in marked.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            rich += AttributedString(source.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
            var label = AttributedString(source.substring(with: match.range(at: 2)))
            if let index = Int(source.substring(with: match.range(at: 1))), destinations.indices.contains(index) {
                label.link = destinations[index]
            }
            rich += label
            cursor = NSMaxRange(match.range)
        }
        rich += AttributedString(source.substring(from: cursor))
        text = String(rich.characters)
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        let links = (try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue))?
            .matches(in: text, range: fullRange) ?? []
        for link in links {
            guard let url = link.url, ["http", "https"].contains(url.scheme),
                  let range = Range(link.range, in: text),
                  let attributedRange = Range(range, in: rich) else { continue }
            if rich[attributedRange].runs.contains(where: { $0.link != nil }) { continue }
            rich[attributedRange].link = url
        }
        let pattern = try! NSRegularExpression(pattern: #"(?<![\w:])(?:\d{1,2}:)?\d{1,3}:[0-5]\d(?![\d:])"#)
        for match in pattern.matches(in: text, range: fullRange) {
            if links.contains(where: { NSIntersectionRange($0.range, match.range).length > 0 }) { continue }
            let parts = nsText.substring(with: match.range).split(separator: ":").compactMap { Int($0) }
            if parts.count == 3, parts[1] >= 60 { continue }
            let seconds = parts.reduce(0) { $0 * 60 + $1 }
            guard duration > 0, seconds <= duration,
                  let range = Range(match.range, in: text),
                  let attributedRange = Range(range, in: rich) else { continue }
            rich[attributedRange].link = URL(string: "wildstring-time://\(seconds)")
            rich[attributedRange].font = .body.monospacedDigit().bold()
        }
        return rich
    }
}
