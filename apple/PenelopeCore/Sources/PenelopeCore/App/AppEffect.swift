/// What the mediator asks of the world outside. Only the root carries these out; an effect with a result is
/// answered with an event.
public enum AppEffect: Equatable, Sendable {
    /// Read the agents this iPhone has kept. Answered with `AppEvent.agentsLoaded`.
    case loadAgents
}
