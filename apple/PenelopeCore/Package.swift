// swift-tools-version: 6.0

import PackageDescription

// The part of the app that decides: the mediator, the derivation of the drawing parameters and the tree the
// components hang in (ADR-0063). It depends on Foundation alone, so its tests run on Linux as well.
let package = Package(
    name: "PenelopeCore",
    products: [
        .library(name: "PenelopeCore", targets: ["PenelopeCore"])
    ],
    targets: [
        .target(name: "PenelopeCore"),
        .testTarget(name: "PenelopeCoreTests", dependencies: ["PenelopeCore"]),
    ]
)
