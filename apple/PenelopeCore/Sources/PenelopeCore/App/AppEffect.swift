import Foundation

/// What the mediator asks of the world outside. Only the root carries these out; an effect with a result is
/// answered with an event.
public enum AppEffect: Equatable, Hashable, Sendable {
    /// Read the agents this iPhone has kept. Answered with `AppEvent.agentsLoaded`.
    case loadAgents
    /// Keep these agents, in this order, replacing what was kept. Not answered.
    case saveAgents([SavedAgent])
    /// Ask `GET /api/agent` at this origin who answers there. Answered with `AppEvent.profileFetched`.
    case fetchProfile(URL)
    /// Sign in to the backend at this origin and keep the token it issues in the Keychain, over what was there.
    /// Answered with `AppEvent.signInFinished`.
    case signIn(URL)
    /// Open `GET /api/summary/stream` with her token after a pause of this many seconds, replacing any stream of
    /// hers. Answered with `AppEvent.summaryReceived` for each summary and one `AppEvent.summaryStreamEnded`.
    case openSummaryStream(URL, generation: Int, after: Int)
    /// Close her stream, and answer nothing more from it.
    case closeSummaryStream(URL)
    /// Revoke her token with `DELETE /api/app/devices/current`, then take it out of the Keychain whatever the
    /// answer. Answered with `AppEvent.agentForgotten`.
    case forgetAgent(URL, name: String)
    /// Open this page in Safari. Not answered.
    case openInBrowser(URL)
}
