import Foundation

/// An agent the owner added to this iPhone, known by the origin of its Web UI. Her name and avatar come from her
/// backend; what is kept here is only what it said last, so that the list has something to show before it answers.
/// Her token is not here: it is in the Keychain, and only the root reads it.
public struct SavedAgent: Equatable, Hashable, Sendable, Codable {
    public var origin: URL
    /// The name her backend last said.
    public var name: String?
    /// The path of her avatar's face under her origin, as her backend last said.
    public var iconPath: String?

    public init(origin: URL, name: String? = nil, iconPath: String? = nil) {
        self.origin = origin
        self.name = name
        self.iconPath = iconPath
    }
}

/// How the summary stream of one agent stands.
public enum AgentLink: Equatable, Sendable {
    /// Opening, or open with nothing said yet.
    case connecting
    /// Open, and her summary has come.
    case live
    /// Lost or refused for a reason other than the token; tried again after a pause.
    case unreachable
    /// Her backend refused the token (or there is none): she needs a new sign-in.
    case signedOut
}

/// What is known of one agent's summary stream.
public struct AgentConnection: Equatable, Sendable {
    public var link: AgentLink
    /// The last summary that came, kept when the stream is lost.
    public var summary: AgentSummary?
    /// Which opening of the stream is the current one. What an older one says is not listened to.
    public var generation = 0
    /// Whether a stream is open or about to be (a retry waiting for its pause counts).
    public var open = false
    /// How many times in a row it was lost, for the pause before the next try.
    public var failures = 0

    public init(link: AgentLink = .connecting, summary: AgentSummary? = nil) {
        self.link = link
        self.summary = summary
    }
}

/// A screen over 「みんな」. 「みんな」 itself is always at the bottom.
public enum Screen: Equatable, Hashable, Sendable {
    case add
    case settings
    /// One agent's screen. The conversation is the next version's; for now it only says so.
    case agent(URL)
}

/// The form of 「エージェントを足す」.
public struct AddForm: Equatable, Sendable {
    public enum Step: Equatable, Sendable {
        case editing
        /// Asking `GET /api/agent` whether a penelope answers there.
        case checking(URL)
        /// Her backend's sign-in is open.
        case signingIn(URL, AgentProfile)
    }

    public enum Problem: Equatable, Sendable {
        case notHTTPS
        case notFound
        case alreadyAdded
        case signInFailed
    }

    public var text = ""
    public var step = Step.editing
    public var problem: Problem?

    public init() {}
}

/// A message to the owner that waits for them to close it.
public enum Notice: Equatable, Sendable {
    /// Signing in again to an agent on the list did not work.
    case signInFailed(name: String)
    /// Her backend could not be told to revoke the token this iPhone forgot.
    case revocationUnconfirmed(name: String)
}

/// Everything the mediator remembers. The drawing parameters are derived from this and from nothing else.
public struct AppState: Equatable, Sendable {
    /// The agents in the owner's order; nil until the saved ones have been read.
    public var agents: [SavedAgent]?
    /// Each agent's summary stream, by origin.
    public var links: [URL: AgentConnection] = [:]
    /// The screens over 「みんな」, the top one last.
    public var screens: [Screen] = []
    public var add = AddForm()
    /// Whether the app is in front. The streams are open only then.
    public var active = false
    /// The agent whose removal is waiting for the owner's yes.
    public var removing: URL?
    /// An agent signing in again from the list, not from the form.
    public var signingInAgain: URL?
    public var notice: Notice?

    public init(agents: [SavedAgent]? = nil) {
        self.agents = agents
    }

    func agent(_ origin: URL) -> SavedAgent? {
        agents?.first { $0.origin == origin }
    }
}
