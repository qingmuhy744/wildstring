import CoreNetwork
import Foundation

enum ErrorText {
    static func message(for error: Error) -> String {
        if let error = error as? APIError {
            switch error.code {
            case "authentication_required": return L10n("errorText.authExpired")
            case "track_not_found": return L10n("errorText.trackNotFound")
            case "podcast_not_found": return L10n("errorText.podcastNotFound")
            case "podcast_publisher_not_found": return L10n("errorText.podcastPublisherNotFound")
            case "podcast_publisher_conflict": return L10n("errorText.podcastPublisherConflict")
            case "podcast_playback_settings_not_found": return L10n("errorText.podcastPlaybackSettingsNotFound")
            case "episode_not_found": return L10n("errorText.episodeNotFound")
            case "episode_unavailable": return L10n("errorText.episodeUnavailable")
            default: return L10n("errorText.serverReturnedStatus", error.statusCode)
            }
        }
        if let error = error as? URLError {
            switch error.code {
            case .timedOut: return L10n("errorText.timedOut")
            case .notConnectedToInternet: return L10n("errorText.notConnectedToInternet")
            case .cannotConnectToHost, .cannotFindHost: return L10n("errorText.cannotConnect")
            default: return L10n("errorText.networkRaw", error.code.rawValue)
            }
        }
        return L10n("errorText.unknown")
    }
}
