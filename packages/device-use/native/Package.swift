// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SimBridge",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "simbridge", targets: ["SimBridge"]),
    ],
    dependencies: [
        .package(url: "https://github.com/httpswift/swifter.git", from: "1.5.0"),
    ],
    targets: [
        .target(
            name: "ObjCBridge",
            dependencies: [],
            path: "Sources/SimBridge/ObjCBridge",
            publicHeadersPath: "include",
            cSettings: [
                .headerSearchPath("include"),
            ]
        ),
        .executableTarget(
            name: "SimBridge",
            dependencies: [
                "ObjCBridge",
                .product(name: "Swifter", package: "swifter"),
            ],
            exclude: ["ObjCBridge"],
            linkerSettings: [
                .linkedFramework("IOSurface"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
            ]
        ),
    ]
)
