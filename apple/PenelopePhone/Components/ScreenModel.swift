import Observation
import PenelopeCore

/// The box the root hands the drawing parameters to SwiftUI in. It is a hand-over, not state: the root writes it
/// and the views read it.
@MainActor
@Observable
final class ScreenModel {
    var props = AppProps.root(AppState())
    var sinks = ScreenSinks()
}

/// The ports of the components, one for each part of a screen that raises events.
struct ScreenSinks {
    var everyone = EveryoneSinks()
}

struct EveryoneSinks {
    var header: EventSink = .ignored
    var empty: EventSink = .ignored
}
