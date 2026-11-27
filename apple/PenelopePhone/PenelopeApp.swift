import PenelopeCore
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
        let root = AppDelegate.makeRoot()
        root.launch()
        return root
    }()

    private static func makeRoot() -> RootComponent {
        #if DEBUG
            if let scene = DemoWorld.requested {
                let demo = DemoWorld(scene: scene)
                return RootComponent(world: demo, script: demo.script)
            }
        #endif
        return RootComponent(world: LiveWorld())
    }

    func application(
        _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(
            self, selector: #selector(movedToBackground), name: UIApplication.didEnterBackgroundNotification,
            object: nil)
        return true
    }

    @objc private func becameActive() {
        root.becameActive()
    }

    @objc private func movedToBackground() {
        root.movedToBackground()
    }
}
