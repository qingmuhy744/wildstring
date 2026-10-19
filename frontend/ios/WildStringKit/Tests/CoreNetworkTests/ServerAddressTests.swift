import Testing
@testable import CoreNetwork

@Suite("ServerAddress")
struct ServerAddressTests {
    @Test func defaultsToHTTPSAndTrimsTrailingSlash() throws {
        let address = try ServerAddress(input: "  music.example.com/  ")
        #expect(address.url.absoluteString == "https://music.example.com")
        #expect(address.origin == "https://music.example.com")
    }

    @Test func keepsExplicitNonDefaultPort() throws {
        let address = try ServerAddress(input: "https://music.example.com:8443")
        #expect(address.url.absoluteString == "https://music.example.com:8443")
        #expect(address.origin == "https://music.example.com:8443")
    }

    @Test func dropsDefaultHTTPSPort() throws {
        let address = try ServerAddress(input: "https://music.example.com:443/")
        #expect(address.url.absoluteString == "https://music.example.com")
    }

    @Test func keepsBasePathWithoutTrailingSlash() throws {
        let address = try ServerAddress(input: "https://example.com/wildstring/")
        #expect(address.url.absoluteString == "https://example.com/wildstring")
        #expect(
            address.appending(path: "api/v1/auth/status").absoluteString
                == "https://example.com/wildstring/api/v1/auth/status"
        )
    }

    @Test func appendingPathToRootAddress() throws {
        let address = try ServerAddress(input: "https://example.com")
        #expect(
            address.appending(path: "/api/v1/auth/login").absoluteString
                == "https://example.com/api/v1/auth/login"
        )
    }

    @Test func rejectsInsecureRemoteHTTP() {
        #expect(throws: ServerAddress.ValidationError.insecureHTTPNotAllowed) {
            try ServerAddress(input: "http://music.example.com")
        }
    }

    @Test func rejectsInsecureLANAddressEvenWhenOptedIn() {
        #expect(throws: ServerAddress.ValidationError.insecureHTTPNotAllowed) {
            try ServerAddress(input: "http://192.168.1.10:8080", allowsInsecureLocalhost: true)
        }
    }

    @Test func allowsLocalhostHTTPOnlyWhenOptedIn() throws {
        let address = try ServerAddress(input: "http://127.0.0.1:18780", allowsInsecureLocalhost: true)
        #expect(address.url.absoluteString == "http://127.0.0.1:18780")
        #expect(throws: ServerAddress.ValidationError.insecureHTTPNotAllowed) {
            try ServerAddress(input: "http://127.0.0.1:18780")
        }
    }

    @Test func rejectsUnsupportedScheme() {
        #expect(throws: ServerAddress.ValidationError.unsupportedScheme) {
            try ServerAddress(input: "ftp://music.example.com")
        }
    }

    @Test func rejectsQueriesFragmentsAndUserInfo() {
        #expect(throws: ServerAddress.ValidationError.invalidURL) {
            try ServerAddress(input: "https://music.example.com/?token=1")
        }
        #expect(throws: ServerAddress.ValidationError.invalidURL) {
            try ServerAddress(input: "https://music.example.com/#frag")
        }
        #expect(throws: ServerAddress.ValidationError.invalidURL) {
            try ServerAddress(input: "https://user:pass@music.example.com")
        }
    }

    @Test func rejectsEmptyInput() {
        #expect(throws: ServerAddress.ValidationError.invalidURL) {
            try ServerAddress(input: "   ")
        }
    }
}
