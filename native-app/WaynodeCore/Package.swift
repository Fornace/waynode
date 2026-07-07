// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "WaynodeCore",
    platforms: [
        .iOS(.v26),
        .macOS(.v26),
    ],
    products: [
        .library(name: "WaynodeCore", targets: ["WaynodeCore"]),
    ],
    targets: [
        .target(
            name: "WaynodeCore",
            path: "Sources/WaynodeCore"
        ),
        .testTarget(
            name: "WaynodeCoreTests",
            dependencies: ["WaynodeCore"],
            path: "Tests/WaynodeCoreTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)
