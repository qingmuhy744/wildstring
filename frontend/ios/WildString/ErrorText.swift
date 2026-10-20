import CoreNetwork
import Foundation

enum ErrorText {
    static func message(for error: Error) -> String {
        if let error = error as? APIError {
            switch error.code {
            case "authentication_required": return "登录已过期，请重新登录"
            case "track_not_found": return "内容已不在曲库"
            default: return "服务器返回错误（\(error.statusCode)）"
            }
        }
        if let error = error as? URLError {
            switch error.code {
            case .timedOut: return "连接超时，请检查网络"
            case .notConnectedToInternet: return "当前网络不可用"
            case .cannotConnectToHost, .cannotFindHost: return "无法连接服务器"
            default: return "网络错误（\(error.code.rawValue)）"
            }
        }
        return "发生未知错误"
    }
}
