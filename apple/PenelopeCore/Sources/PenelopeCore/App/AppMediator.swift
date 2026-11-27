/// The one place where it is decided what happens next: a pure state machine, `(State, Event) -> (State, [Effect])`
/// (ADR-0063). It touches nothing outside its arguments; what has to happen in the world is returned as effects.
public enum AppMediator {
    public static func reduce(_ state: AppState, _ event: AppEvent) -> (AppState, [AppEffect]) {
        var state = state
        switch event {
        case .launched:
            return (state, [.loadAgents])
        case .agentsLoaded(let agents):
            state.agents = agents
            return (state, [])
        case .addAgentRequested, .appSettingsRequested:
            // The screens these open are not built yet.
            return (state, [])
        }
    }
}
