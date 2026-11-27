import Foundation
import Observation
import PenelopeCore

/// The box the root hands the drawing parameters to SwiftUI in. It is a hand-over, not state: the root writes it
/// and the views read it.
@MainActor
@Observable
final class ScreenModel {
    var props = AppProps.root(AppState(), now: Date(), calendar: .current)
    var sinks = ScreenSinks()
}

/// The ports of the components, one for each part of a screen that raises events.
struct ScreenSinks {
    /// Going back, by the back button or the swipe from the edge.
    var navigation: EventSink = .ignored
    /// The buttons of a question or a notice.
    var alert: EventSink = .ignored
    var everyone = EveryoneSinks()
    var add: EventSink = .ignored
    var settings = SettingsSinks()
    var agent: EventSink = .ignored
}

struct EveryoneSinks {
    var header: EventSink = .ignored
    var empty: EventSink = .ignored
    var rows: EventSink = .ignored
}

struct SettingsSinks {
    var rows: EventSink = .ignored
    var footer: EventSink = .ignored
}
