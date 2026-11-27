import Foundation

/// What a `summary` event of `GET /api/summary/stream` says about one deployment (docs/ui-api.md「要約の流れ」).
public struct AgentSummary: Equatable, Hashable, Sendable {
    public var state: SummaryState
    /// The last thing said, by her or by the owner; nil when nothing has been said yet.
    public var lastMessage: LastMessage?
    /// Her replies the owner has not read.
    public var unread: Int
    /// Failures in the activity record the owner has not seen.
    public var unseenFailures: Int

    public init(state: SummaryState, lastMessage: LastMessage?, unread: Int, unseenFailures: Int) {
        self.state = state
        self.lastMessage = lastMessage
        self.unread = unread
        self.unseenFailures = unseenFailures
    }

    /// Reads the JSON of the event's data.
    public static func decode(_ data: Data) throws -> AgentSummary {
        let wire = try JSONDecoder().decode(Wire.self, from: data)
        let state: SummaryState
        switch wire.state.kind {
        case "thinking": state = .thinking
        case "tool": state = .tool(wire.state.tool ?? "")
        case "approval": state = .approval(pending: wire.state.pending ?? 1)
        // A state this app does not know yet is shown as the quietest one.
        default: state = .waiting
        }
        let last = try wire.last_message.map { message in
            guard let at = RFC3339.date(message.at) else {
                throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "at: \(message.at)"))
            }
            return LastMessage(kind: message.kind == "owner" ? .owner : .agent, at: at, text: message.text)
        }
        return AgentSummary(state: state, lastMessage: last, unread: wire.unread, unseenFailures: wire.unseen_failures)
    }

    private struct Wire: Decodable {
        struct State: Decodable {
            var kind: String
            var tool: String?
            var pending: Int?
        }
        struct Message: Decodable {
            var kind: String
            var at: String
            var text: String
        }
        var state: State
        var last_message: Message?
        var unread: Int
        var unseen_failures: Int
    }
}

public enum SummaryState: Equatable, Hashable, Sendable {
    /// Waiting for an event.
    case waiting
    /// In a turn.
    case thinking
    /// In a turn, with a tool whose result has not come back: its name and the head of what it was given.
    case tool(String)
    /// Stopped until the owner answers approvals. The backend does not send it yet.
    case approval(pending: Int)
}

public struct LastMessage: Equatable, Hashable, Sendable {
    public enum Kind: Equatable, Hashable, Sendable { case owner, agent }

    public var kind: Kind
    public var at: Date
    /// Its first line; empty when it had no text.
    public var text: String

    public init(kind: Kind, at: Date, text: String) {
        self.kind = kind
        self.at = at
        self.text = text
    }
}

/// What `GET /api/agent` says: who answers at a deployment. Only a penelope answers this way.
public struct AgentProfile: Equatable, Hashable, Sendable {
    public var name: String
    /// The path of her avatar's face shown in lists, under her origin; nil when she has no avatar.
    public var iconPath: String?

    public init(name: String, iconPath: String?) {
        self.name = name
        self.iconPath = iconPath
    }

    /// Reads the answer, or nil when it is not the answer of a penelope.
    public static func decode(_ data: Data) -> AgentProfile? {
        struct Wire: Decodable {
            var name: String
            var icons: [String: String]?
        }
        guard let wire = try? JSONDecoder().decode(Wire.self, from: data) else { return nil }
        let icons = wire.icons ?? [:]
        // The neutral face, as the Web UI falls back to (docs/ui-api.md「エージェント」).
        let icon = icons["neutral"] ?? icons.keys.sorted().first.flatMap { icons[$0] }
        return AgentProfile(name: wire.name, iconPath: icon)
    }
}

enum RFC3339 {
    static func date(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}
