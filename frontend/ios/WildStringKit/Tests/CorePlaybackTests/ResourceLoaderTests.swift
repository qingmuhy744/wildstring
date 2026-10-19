import CoreNetwork
import Foundation
import Testing
@testable import CorePlayback

@Suite("WildstringAudioResourceLoader")
struct ResourceLoaderTests {
    @Test func assetURLUsesCustomScheme() throws {
        let server = try ServerAddress(input: "https://music.example.com")
        let url = WildstringAudioResourceLoader.assetURL(
            server: server,
            path: "api/v1/tracks/t1/stream"
        )
        #expect(url.scheme == "wildstring-audio")
        #expect(url.host == "music.example.com")
        #expect(url.path == "/api/v1/tracks/t1/stream")
    }

    @Test func assetURLKeepsExplicitPort() throws {
        let server = try ServerAddress(input: "https://music.example.com:8443")
        let url = WildstringAudioResourceLoader.assetURL(server: server, path: "x")
        #expect(url.absoluteString == "wildstring-audio://music.example.com:8443/x")
    }

    @Test func requestPathStripsCustomScheme() {
        let url = URL(string: "wildstring-audio://music.example.com/api/v1/tracks/t1/stream")!
        #expect(
            WildstringAudioResourceLoader.requestPath(from: url)
                == "api/v1/tracks/t1/stream"
        )
    }

    @Test func requestPathPreservesQueryForTranscodeStreams() {
        let url = URL(
            string:
                "wildstring-audio://music.example.com/api/v1/tracks/t1/stream?format=aac&bitrate_kbps=192&start_ms=53000"
        )!
        #expect(
            WildstringAudioResourceLoader.requestPath(from: url)
                == "api/v1/tracks/t1/stream?format=aac&bitrate_kbps=192&start_ms=53000"
        )
    }

    @Test func requestPathRejectsForeignSchemes() {
        #expect(
            WildstringAudioResourceLoader.requestPath(from: URL(string: "https://x/y")!)
                == nil
        )
        #expect(WildstringAudioResourceLoader.requestPath(from: nil) == nil)
    }

    @Test func utiMappingCoversCommonTypes() {
        #expect(WildstringAudioResourceLoader.uti(forMimeType: "audio/mpeg") == "public.mp3")
        #expect(WildstringAudioResourceLoader.uti(forMimeType: "audio/flac") == "org.xiph.flac")
        #expect(
            WildstringAudioResourceLoader.uti(forMimeType: "audio/mp4")
                == "public.mpeg-4-audio"
        )
    }
}
