import Foundation

/// An agent the owner added to this iPhone, known by the URL of its Web UI. Its name and avatar come from its
/// backend, never from the app.
public struct SavedAgent: Equatable, Sendable {
    public let origin: URL

    public init(origin: URL) {
        self.origin = origin
    }
}

/// Everything the mediator remembers. The drawing parameters are derived from this and from nothing else.
public struct AppState: Equatable, Sendable {
    /// The agents in the owner's order; nil until the saved ones have been read.
    public var agents: [SavedAgent]?

    public init(agents: [SavedAgent]? = nil) {
        self.agents = agents
    }
}
