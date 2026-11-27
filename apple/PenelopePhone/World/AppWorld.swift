import Foundation
import PenelopeCore

/// The world outside, as the root carries out the mediator's effects in it: what is kept on this iPhone, the
/// Keychain, and the agents' backends. The root holds one of these; nothing else does.
///
/// It is a protocol so that a debug build can stand a made-up world in for the real one (`DemoWorld`).
@MainActor
protocol AppWorld {
    /// The agents kept on this iPhone, in the owner's order.
    func loadAgents() -> [SavedAgent]
    func saveAgents(_ agents: [SavedAgent])
    /// Who answers `GET /api/agent` at this origin; nil when no penelope does.
    func profile(at origin: URL) async -> AgentProfile?
    /// Signs in to her backend and keeps the token it issues.
    func signIn(to origin: URL) async -> SignInResult
    /// Reads her summary stream until it ends, handing each summary to `received`. Returns why it ended; when the
    /// task is cancelled it returns at once and what it returns is not used.
    func streamSummaries(at origin: URL, received: @escaping @MainActor (AgentSummary) -> Void) async -> StreamEnd
    /// Revokes her token at her backend and forgets it here. Returns whether the backend confirmed it.
    func forget(_ origin: URL) async -> Bool
    func openInBrowser(_ url: URL)
}
