import PenelopeCore

/// The root of the tree, and the only part of it anything outside may hold (ADR-0063).
///
/// It keeps the state, asks the mediator about every event, carries out the effects the mediator returns, and
/// hands the screens their drawing parameters through `ScreenModel`. What the owner does arrives from the
/// components below; what the world outside says is raised here. Both go through the same `deliver`.
@MainActor
final class RootComponent: Component {
    let model = ScreenModel()
    private var state = AppState()

    private let everyone = EveryoneComponent()

    private var pending: [AppEvent] = []
    private var draining = false

    init() {
        super.init(name: "root")
        adopt(everyone)
        model.sinks = ScreenSinks(
            everyone: EveryoneSinks(header: everyone.header.sink, empty: everyone.empty.sink))
    }

    /// The chain ends here: everything that reaches the root goes to the mediator.
    override func handle(_ event: AppEvent) -> Bool {
        deliver(event)
        return true
    }

    func launch() {
        deliver(.launched)
    }

    // MARK: - One event at a time

    /// Events are settled one by one. An effect may raise another event, so they queue up rather than nest, and
    /// the screen is drawn once at the end.
    private func deliver(_ event: AppEvent) {
        pending.append(event)
        guard !draining else { return }
        draining = true
        defer { draining = false }
        while !pending.isEmpty {
            let (next, effects) = AppMediator.reduce(state, pending.removeFirst())
            state = next
            effects.forEach(perform)
        }
        refresh()
    }

    /// Draws again only when the drawing parameters changed.
    private func refresh() {
        let props = AppProps.root(state)
        if props != model.props { model.props = props }
    }

    // MARK: - Effects

    private func perform(_ effect: AppEffect) {
        switch effect {
        case .loadAgents:
            // Nothing is kept yet: the store arrives with the screen that adds an agent.
            deliver(.agentsLoaded([]))
        }
    }
}
