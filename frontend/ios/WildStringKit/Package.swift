// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WildStringKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CoreNetwork", targets: ["CoreNetwork"]),
        .library(name: "CorePlayback", targets: ["CorePlayback"]),
    ],
    targets: [
        .target(name: "CoreNetwork"),
        .target(name: "CorePlayback", dependencies: ["CoreNetwork"]),
        .testTarget(name: "CoreNetworkTests", dependencies: ["CoreNetwork"]),
        .testTarget(name: "CorePlaybackTests", dependencies: ["CorePlayback"]),
    ]
)
