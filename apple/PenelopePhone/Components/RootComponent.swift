import Foundation
import PenelopeCore

/// The root of the tree, and the only part of it anything outside may hold (ADR-0063).
///
/// It keeps the state, asks the mediator about every event, carries out the effects the mediator returns in the
/// world, and hands the screens their drawing parameters through `ScreenModel`. What the owner does arrives from the
/// components below; what the world outside says is raised here. Both go through the same `deliver`.
@MainActor
final class RootComponent: Component {
    let model = ScreenModel()
    private var state = AppState()
    private let world: any AppWorld
    /// What a demo scene has the owner do after the launch.
    private let script: [AppEvent]

    private let navigation = Component(name: "navigation")
    private let alert = Component(name: "alert")
    private let everyone = EveryoneComponent()
    private let add = AddAgentComponent()
    private let settings = SettingsComponent()
    private let agent = AgentComponent()

    /// Each agent's summary stream, by origin.
    private var streams: [URL: Task<Void, Never>] = [:]

    init(world: any AppWorld, script: [AppEvent] = []) {
        self.world = world
        self.script = script
        super.init(name: "root")
        [navigation, alert, everyone, add, settings, agent].forEach(adopt)
        model.sinks = ScreenSinks(
            navigation: navigation.sink,
            alert: alert.sink,
            everyone: EveryoneSinks(header: everyone.header.sink, empty: everyone.empty.sink, rows: everyone.rows.sink),
            add: add.form.sink,
            settings: SettingsSinks(rows: settings.rows.sink, footer: settings.footer.sink),
            agent: agent.sink)
    }

    /// The chain ends here: everything that reaches the root goes to the mediator.
    override func handle(_ event: AppEvent) -> Bool {
        deliver(event)
        return true
    }

    func launch() {
        deliver(.launched)
        script.forEach(deliver)
    }

    func becameActive() {
        deliver(.becameActive)
    }

    func movedToBackground() {
        deliver(.movedToBackground)
    }

    // MARK: - One event at a time

    private var pending: [AppEvent] = []
    private var draining = false

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
        let props = AppProps.root(state, now: Date(), calendar: .current)
        if props != model.props { model.props = props }
    }

    // MARK: - Effects

    private func perform(_ effect: AppEffect) {
        switch effect {
        case .loadAgents:
            deliver(.agentsLoaded(world.loadAgents()))
        case .saveAgents(let agents):
            world.saveAgents(agents)
        case .fetchProfile(let origin):
            Task {
                let profile = await world.profile(at: origin)
                deliver(.profileFetched(origin, profile))
            }
        case .signIn(let origin):
            Task {
                let result = await world.signIn(to: origin)
                deliver(.signInFinished(origin, result))
            }
        case .openSummaryStream(let origin, let generation, let pause):
            streams[origin]?.cancel()
            streams[origin] = Task {
                if pause > 0 {
                    guard (try? await Task.sleep(for: .seconds(pause))) != nil else { return }
                }
                let end = await world.streamSummaries(at: origin) { summary in
                    guard !Task.isCancelled else { return }
                    self.deliver(.summaryReceived(origin, generation: generation, summary))
                }
                // A closed stream says nothing more.
                guard !Task.isCancelled else { return }
                deliver(.summaryStreamEnded(origin, generation: generation, end))
            }
        case .closeSummaryStream(let origin):
            streams.removeValue(forKey: origin)?.cancel()
        case .forgetAgent(let origin, let name):
            Task {
                let revoked = await world.forget(origin)
                deliver(.agentForgotten(name: name, revoked: revoked))
            }
        case .openInBrowser(let url):
            world.openInBrowser(url)
        }
    }
}
