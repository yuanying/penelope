import Foundation

/// The one place where it is decided what happens next: a pure state machine, `(State, Event) -> (State, [Effect])`
/// (ADR-0063). It touches nothing outside its arguments; what has to happen in the world is returned as effects.
public enum AppMediator {
    public static func reduce(_ state: AppState, _ event: AppEvent) -> (AppState, [AppEffect]) {
        var state = state
        var effects = settle(&state, event)
        effects += reconcileStreams(&state)
        return (state, effects)
    }

    // MARK: - Events

    private static func settle(_ state: inout AppState, _ event: AppEvent) -> [AppEffect] {
        switch event {
        case .launched:
            state.active = true
            return [.loadAgents]
        case .becameActive:
            state.active = true
            return []
        case .movedToBackground:
            state.active = false
            return []

        case .agentsLoaded(let agents):
            state.agents = agents
            state.links = Dictionary(uniqueKeysWithValues: agents.map { ($0.origin, AgentConnection()) })
            // Her name and avatar may have changed since they were kept.
            return agents.map { .fetchProfile($0.origin) }

        case .addAgentRequested:
            guard state.screens.last != .add, !signingIn(state) else { return [] }
            state.add = AddForm()
            state.screens.append(.add)
            return []
        case .appSettingsRequested:
            guard state.screens.isEmpty else { return [] }
            state.screens.append(.settings)
            return []
        case .agentOpened(let origin):
            guard state.screens.isEmpty, state.agent(origin) != nil else { return [] }
            state.screens.append(.agent(origin))
            return []
        case .navigatedBack(let depth):
            guard depth >= 0, depth < state.screens.count else { return [] }
            let left = state.screens[depth...]
            state.screens.removeSubrange(depth...)
            if left.contains(.add), !signingIn(state) { state.add = AddForm() }
            return []
        case .webRequested(let origin):
            return [.openInBrowser(origin)]
        case .noticeDismissed:
            state.notice = nil
            return []

        case .addURLChanged(let text):
            guard state.add.step == .editing else { return [] }
            state.add.text = text
            state.add.problem = nil
            return []
        case .addSubmitted:
            return submit(&state)
        case .profileFetched(let origin, let profile):
            return profileFetched(&state, origin, profile)

        case .signInAgainRequested(let origin):
            guard state.links[origin]?.link == .signedOut, !signingIn(state) else { return [] }
            state.signingInAgain = origin
            return [.signIn(origin)]
        case .signInFinished(let origin, let result):
            return signInFinished(&state, origin, result)

        case .summaryReceived(let origin, let generation, let summary):
            guard var link = state.links[origin], link.generation == generation, link.open else { return [] }
            link.link = .live
            link.summary = summary
            link.failures = 0
            state.links[origin] = link
            return []
        case .summaryStreamEnded(let origin, let generation, let end):
            return streamEnded(&state, origin, generation, end)

        case .removeRequested(let origin):
            guard state.agent(origin) != nil else { return [] }
            state.removing = origin
            return []
        case .removeCancelled:
            state.removing = nil
            return []
        case .removeConfirmed:
            return remove(&state)
        case .agentForgotten(let name, let revoked):
            if !revoked { state.notice = .revocationUnconfirmed(name: name) }
            return []

        case .agentsMoved(let from, let to):
            guard var agents = state.agents else { return [] }
            agents.move(fromOffsets: from, toOffset: to)
            guard agents != state.agents else { return [] }
            state.agents = agents
            return [.saveAgents(agents)]
        }
    }

    private static func signingIn(_ state: AppState) -> Bool {
        if state.signingInAgain != nil { return true }
        if case .signingIn = state.add.step { return true }
        return false
    }

    private static func submit(_ state: inout AppState) -> [AppEffect] {
        guard state.add.step == .editing else { return [] }
        guard let origin = AgentAddress.origin(of: state.add.text) else {
            state.add.problem = .notHTTPS
            return []
        }
        guard state.agent(origin) == nil else {
            state.add.problem = .alreadyAdded
            return []
        }
        state.add.problem = nil
        state.add.step = .checking(origin)
        return [.fetchProfile(origin)]
    }

    private static func profileFetched(_ state: inout AppState, _ origin: URL, _ profile: AgentProfile?) -> [AppEffect] {
        var effects: [AppEffect] = []
        if let profile, let index = state.agents?.firstIndex(where: { $0.origin == origin }) {
            let known = state.agents![index]
            let updated = SavedAgent(origin: origin, name: profile.name, iconPath: profile.iconPath)
            if known != updated {
                state.agents![index] = updated
                effects.append(.saveAgents(state.agents!))
            }
        }
        if state.add.step == .checking(origin) {
            if let profile {
                state.add.step = .signingIn(origin, profile)
                effects.append(.signIn(origin))
            } else {
                state.add.step = .editing
                state.add.problem = .notFound
            }
        }
        return effects
    }

    private static func signInFinished(_ state: inout AppState, _ origin: URL, _ result: SignInResult) -> [AppEffect] {
        if state.signingInAgain == origin {
            state.signingInAgain = nil
            switch result {
            case .signedIn:
                state.links[origin] = AgentConnection(summary: state.links[origin]?.summary)
            case .cancelled:
                break
            case .failed:
                state.notice = .signInFailed(name: displayName(state.agent(origin), origin))
            }
            return []
        }
        guard case .signingIn(origin, let profile) = state.add.step else { return [] }
        switch result {
        case .signedIn:
            var agents = state.agents ?? []
            let agent = SavedAgent(origin: origin, name: profile.name, iconPath: profile.iconPath)
            if let index = agents.firstIndex(where: { $0.origin == origin }) {
                agents[index] = agent
            } else {
                agents.append(agent)
            }
            state.agents = agents
            state.links[origin] = AgentConnection()
            state.add = AddForm()
            state.screens = []
            return [.saveAgents(agents)]
        case .cancelled:
            state.add.step = .editing
            return []
        case .failed:
            state.add.step = .editing
            state.add.problem = .signInFailed
            return []
        }
    }

    private static func remove(_ state: inout AppState) -> [AppEffect] {
        guard let origin = state.removing, let agent = state.agent(origin) else {
            state.removing = nil
            return []
        }
        state.removing = nil
        var effects: [AppEffect] = []
        if state.links[origin]?.open == true { effects.append(.closeSummaryStream(origin)) }
        state.links[origin] = nil
        state.agents?.removeAll { $0.origin == origin }
        state.screens.removeAll { $0 == .agent(origin) }
        effects.append(.forgetAgent(origin, name: displayName(agent, origin)))
        effects.append(.saveAgents(state.agents ?? []))
        return effects
    }

    // MARK: - The summary streams

    /// The pauses before trying a lost stream again, by how many times in a row it was lost.
    static let retryPauses = [1, 2, 5, 10, 30]

    private static func streamEnded(_ state: inout AppState, _ origin: URL, _ generation: Int, _ end: StreamEnd)
        -> [AppEffect]
    {
        guard var link = state.links[origin], link.generation == generation, link.open else { return [] }
        link.open = false
        switch end {
        case .unauthorized:
            link.link = .signedOut
            state.links[origin] = link
            return []
        case .failed:
            link.link = .unreachable
            link.failures += 1
            state.links[origin] = link
            guard wantsStream(state, origin) else { return [] }
            return [open(&state, origin, after: retryPauses[min(link.failures, retryPauses.count) - 1])]
        }
    }

    /// The streams are open while the app is in front and the list, or a screen of the list's own, is up. Her own
    /// screen will have her conversation's stream instead (ADR-0066).
    private static func wantsStream(_ state: AppState, _ origin: URL) -> Bool {
        guard state.active, state.agent(origin) != nil, let link = state.links[origin] else { return false }
        if case .agent = state.screens.last { return false }
        return link.link != .signedOut
    }

    private static func open(_ state: inout AppState, _ origin: URL, after pause: Int) -> AppEffect {
        var link = state.links[origin] ?? AgentConnection()
        link.generation += 1
        link.open = true
        if pause == 0 { link.link = .connecting }
        state.links[origin] = link
        return .openSummaryStream(origin, generation: link.generation, after: pause)
    }

    /// Opens what should be open and closes what should not, after every event.
    private static func reconcileStreams(_ state: inout AppState) -> [AppEffect] {
        var effects: [AppEffect] = []
        for agent in state.agents ?? [] {
            let origin = agent.origin
            guard let link = state.links[origin] else { continue }
            let wanted = wantsStream(state, origin)
            if wanted, !link.open {
                effects.append(open(&state, origin, after: 0))
            } else if !wanted, link.open {
                state.links[origin]?.open = false
                effects.append(.closeSummaryStream(origin))
            }
        }
        return effects
    }

    static func displayName(_ agent: SavedAgent?, _ origin: URL) -> String {
        agent?.name ?? origin.host ?? origin.absoluteString
    }
}

extension Array {
    /// Foundation has no `move(fromOffsets:toOffset:)` (SwiftUI adds it), so the list's reordering is spelled here.
    mutating func move(fromOffsets offsets: [Int], toOffset destination: Int) {
        let picked = offsets.filter { indices.contains($0) }.sorted()
        guard !picked.isEmpty, (0...count).contains(destination) else { return }
        let moving = picked.map { self[$0] }
        let before = picked.filter { $0 < destination }.count
        for index in picked.reversed() { remove(at: index) }
        insert(contentsOf: moving, at: destination - before)
    }
}
