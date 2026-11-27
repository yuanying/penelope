/// A button whose wording or meaning depends on the state: what it says and what it raises.
public struct ActionProps: Equatable, Sendable {
    public let label: String
    public let event: AppEvent

    public init(label: String, event: AppEvent) {
        self.label = label
        self.event = event
    }
}

/// What the whole screen is drawn from.
public struct RootProps: Equatable, Sendable {
    public var everyone: EveryoneProps
}

/// 「みんな」, the list of the agents.
public struct EveryoneProps: Equatable, Sendable {
    public var body: Body

    public enum Body: Equatable, Sendable {
        /// Nothing is known yet, so nothing is claimed.
        case blank
        /// No agent has been added.
        case empty(EmptyListProps)
        case rows([AgentRowProps])
    }
}

public struct EmptyListProps: Equatable, Sendable {
    public var title: String
    public var message: String
    public var action: ActionProps
}

/// One agent's row of the list.
public struct AgentRowProps: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
}

/// The derivation of the drawing parameters from the state. Nothing else makes them.
public enum AppProps {
    public static func root(_ state: AppState) -> RootProps {
        RootProps(everyone: EveryoneProps(body: everyoneBody(state.agents)))
    }

    private static func everyoneBody(_ agents: [SavedAgent]?) -> EveryoneProps.Body {
        guard let agents else { return .blank }
        guard !agents.isEmpty else {
            return .empty(
                EmptyListProps(
                    title: "まだ誰もいません",
                    message: "エージェントの URL を入れて、ログインすると、ここに並びます。",
                    action: ActionProps(label: "エージェントを足す", event: .addAgentRequested)))
        }
        // Until the name arrives from the backend, the host stands in for it.
        return .rows(
            agents.map { AgentRowProps(id: $0.origin.absoluteString, name: $0.origin.host ?? $0.origin.absoluteString) })
    }
}
