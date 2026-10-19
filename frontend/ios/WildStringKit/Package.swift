// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WildStringKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CoreNetwork", targets: ["CoreNetwork"]),
    ],
    targets: [
        .target(name: "CoreNetwork"),
        .testTarget(name: "CoreNetworkTests", dependencies: ["CoreNetwork"]),
    ]
)
