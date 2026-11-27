import SwiftUI

@main
struct PenelopeApp: App {
    @UIApplicationDelegateAdaptor private var delegate: AppDelegate

    var body: some Scene {
        WindowGroup {
            ScreenView(model: delegate.root.model)
        }
    }
}

/// The only thing that holds the root, and it holds nothing else of the tree (ADR-0063). What iOS says to the app
/// arrives here and is passed to the root.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    let root: RootComponent = {
        let root = RootComponent()
        root.launch()
        return root
    }()
}

/// Draws whichever screen the drawing parameters say is up.
struct ScreenView: View {
    let model: ScreenModel

    var body: some View {
        EveryoneView(props: model.props.everyone, sinks: model.sinks.everyone)
    }
}
