/// Everything the mediator is asked to settle: what the owner did, and what the world outside answered. Both come
/// in through the root.
public enum AppEvent: Equatable, Sendable {
    /// The app started.
    case launched
    /// The answer to `AppEffect.loadAgents`: the agents this iPhone has kept, in the owner's order.
    case agentsLoaded([SavedAgent])
    /// The owner asked to add an agent: 「＋」, or the button of the empty list.
    case addAgentRequested
    /// The owner asked for the app's own settings: the gear.
    case appSettingsRequested
}
