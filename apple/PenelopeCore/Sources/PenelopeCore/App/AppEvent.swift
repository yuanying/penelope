import Foundation

/// Everything the mediator is asked to settle: what the owner did, and what the world outside answered. Both come
/// in through the root.
public enum AppEvent: Equatable, Hashable, Sendable {
    // MARK: The app

    /// The app started.
    case launched
    /// The app came to the front.
    case becameActive
    /// The app went to the background.
    case movedToBackground

    // MARK: What the owner did

    /// 「＋」, the button of the empty list, or the one at the bottom of the app's settings.
    case addAgentRequested
    /// The gear.
    case appSettingsRequested
    /// The owner went back to the screen this many screens over 「みんな」 (0 is 「みんな」 itself).
    case navigatedBack(depth: Int)
    /// A row of 「みんな」.
    case agentOpened(URL)
    /// A row whose sign-in no longer works.
    case signInAgainRequested(URL)
    /// Her Web UI, in Safari.
    case webRequested(URL)
    /// The URL field of 「エージェントを足す」.
    case addURLChanged(String)
    /// 「ログインに進む」.
    case addSubmitted
    /// 「外す」 on a row of the app's settings: asks first.
    case removeRequested(URL)
    case removeConfirmed
    case removeCancelled
    /// The rows of the app's settings were moved, as `Array.move(fromOffsets:toOffset:)` takes it.
    case agentsMoved(from: [Int], to: Int)
    /// The owner closed the notice.
    case noticeDismissed

    // MARK: What the world answered

    /// The answer to `AppEffect.loadAgents`: the agents this iPhone has kept, in the owner's order.
    case agentsLoaded([SavedAgent])
    /// The answer to `AppEffect.fetchProfile`: nil when no penelope answered there.
    case profileFetched(URL, AgentProfile?)
    /// The answer to `AppEffect.signIn`.
    case signInFinished(URL, SignInResult)
    /// A summary came on the stream `AppEffect.openSummaryStream` opened.
    case summaryReceived(URL, generation: Int, AgentSummary)
    /// That stream ended.
    case summaryStreamEnded(URL, generation: Int, StreamEnd)
    /// The answer to `AppEffect.forgetAgent`: whether her backend confirmed the token is revoked.
    case agentForgotten(name: String, revoked: Bool)
}

public enum SignInResult: Equatable, Hashable, Sendable {
    /// Her token is in the Keychain.
    case signedIn
    /// The owner closed the sign-in.
    case cancelled
    case failed
}

public enum StreamEnd: Equatable, Hashable, Sendable {
    /// `401`, or no token in the Keychain.
    case unauthorized
    /// Anything else: the network, the backend going away, another status.
    case failed
}
