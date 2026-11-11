import Foundation

/// Fake network for audio in `PlaybackService` tests: every request is accepted and never
/// answered, like a stalled connection, until AVFoundation cancels it. It keeps the audio
/// resource loader off the real network (`music.example.com`), so no real load failure can
/// arrive at an arbitrary moment, and it shares no state with `StubURLProtocol`, whose handler
/// other suites replace while they run.
final class StalledAudioURLProtocol: URLProtocol {
    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StalledAudioURLProtocol.self]
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 3_600
        return configuration
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {}
    override func stopLoading() {}
}
