import Testing

@testable import PenelopeCore

@MainActor
struct TreeComponentTests {
    /// The root is where the mediator is asked, so what a view raises anywhere below has to arrive there.
    @Test func anEventRaisedBelowReachesTheRoot() {
        final class Root: TreeComponent<String> {
            var received: [String] = []
            override func handle(_ event: String) -> Bool {
                received.append(event)
                return true
            }
        }
        let root = Root(name: "root")
        let screen = TreeComponent<String>(name: "screen")
        let button = TreeComponent<String>(name: "screen.button")
        root.adopt(screen)
        screen.adopt(button)

        button.sink("pressed")

        #expect(root.received == ["pressed"])
    }
}
