import Foundation

/// A button whose wording or meaning depends on the state: what it says, what it raises, and whether it can be
/// pressed now.
public struct ActionProps: Equatable, Sendable {
    public let label: String
    public let event: AppEvent
    public let enabled: Bool

    public init(label: String, event: AppEvent, enabled: Bool = true) {
        self.label = label
        self.event = event
        self.enabled = enabled
    }
}

/// What the whole screen is drawn from.
public struct RootProps: Equatable, Sendable {
    public var everyone: EveryoneProps
    /// The screens over 「みんな」, the top one last.
    public var path: [RouteProps]
    public var add: AddAgentProps
    public var settings: SettingsProps
    /// The agent's screen, when one is open.
    public var agent: AgentScreenProps?
    /// A question or a notice over everything, waiting for the owner.
    public var alert: AlertProps?
}

/// Which screen stands at a place of the navigation.
public enum RouteProps: Hashable, Sendable {
    case add
    case settings
    case agent(String)
}

// MARK: - 「みんな」

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

/// One agent's row of the list (18 章「一覧」3).
public struct AgentRowProps: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var avatar: AvatarProps
    public var status: StatusProps
    /// The last thing said, by her or by the owner; empty when nothing is known.
    public var lastMessage: String
    /// When it was said: the time today, 「昨日」, or the date. Empty when nothing is known.
    public var time: String
    /// The failures she has that the owner has not seen; nil at zero.
    public var failures: BadgeProps?
    /// Her replies the owner has not read; nil at zero.
    public var unread: BadgeProps?
    /// What pressing the row raises.
    public var action: AppEvent
    /// The whole row read out at once.
    public var accessibilityLabel: String
}

/// An agent's face: the image at `url`, or her initial until it shows.
public struct AvatarProps: Equatable, Sendable {
    public var url: URL?
    public var initial: String
}

/// The state line: a mark and words, never a colour alone (18 章「一覧」4).
public struct StatusProps: Equatable, Sendable {
    public enum Mark: Equatable, Sendable {
        case dot
        case pause
        case warning
    }

    public enum Tone: Equatable, Sendable {
        /// `--color-text-info`: she is doing something.
        case info
        /// The quiet colour of secondary text.
        case muted
        /// `--color-on-warning-muted`: something is in the way.
        case warning
    }

    public var mark: Mark
    public var tone: Tone
    public var text: String
    /// The tool, in monospace beside the words.
    public var detail: String?
}

public struct BadgeProps: Equatable, Sendable {
    public var text: String
    public var accessibilityLabel: String
}

// MARK: - The other screens

/// 「エージェントを足す」.
public struct AddAgentProps: Equatable, Sendable {
    public var text: String
    public var placeholder: String
    /// The words under the field.
    public var help: String
    /// What is wrong, in place of the help; the field is drawn as wrong too.
    public var problem: String?
    /// Whether the app is waiting for her backend.
    public var busy: Bool
    public var submit: ActionProps
}

/// The app's own settings.
public struct SettingsProps: Equatable, Sendable {
    public var caption: String
    public var rows: [SettingsRowProps]
    public var add: ActionProps
}

public struct SettingsRowProps: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var avatar: AvatarProps
    /// The host, and 「つながらない」 when she cannot be reached.
    public var detail: String
    public var remove: ActionProps
    /// 「外す」 read out with her name, since several rows have the same button.
    public var removeAccessibilityLabel: String
}

/// One agent's screen, until the conversation comes in the next version.
public struct AgentScreenProps: Equatable, Sendable {
    public var title: String
    public var message: String
    public var web: ActionProps
}

public struct AlertProps: Equatable, Sendable {
    public struct Action: Equatable, Sendable {
        public enum Role: Equatable, Sendable { case normal, cancel, destructive }
        public var label: String
        public var event: AppEvent
        public var role: Role
    }

    public var title: String
    public var message: String
    public var actions: [Action]
}

// MARK: - The derivation

/// The derivation of the drawing parameters from the state. Nothing else makes them. The time of day and the calendar
/// are given by the root, since what 「今日」 is depends on them.
public enum AppProps {
    public static func root(_ state: AppState, now: Date, calendar: Calendar) -> RootProps {
        RootProps(
            everyone: EveryoneProps(body: everyoneBody(state, now: now, calendar: calendar)),
            path: state.screens.map(route),
            add: add(state.add),
            settings: settings(state),
            agent: agentScreen(state),
            alert: alert(state))
    }

    private static func route(_ screen: Screen) -> RouteProps {
        switch screen {
        case .add: .add
        case .settings: .settings
        case .agent(let origin): .agent(origin.absoluteString)
        }
    }

    private static func everyoneBody(_ state: AppState, now: Date, calendar: Calendar) -> EveryoneProps.Body {
        guard let agents = state.agents else { return .blank }
        guard !agents.isEmpty else {
            return .empty(
                EmptyListProps(
                    title: "まだ誰もいません",
                    message: "エージェントの URL を入れて、ログインすると、ここに並びます。",
                    action: ActionProps(label: "エージェントを足す", event: .addAgentRequested)))
        }
        return .rows(agents.map { row($0, state.links[$0.origin] ?? AgentConnection(), now: now, calendar: calendar) })
    }

    private static func row(_ agent: SavedAgent, _ link: AgentConnection, now: Date, calendar: Calendar)
        -> AgentRowProps
    {
        let name = AppMediator.displayName(agent, agent.origin)
        let summary = link.summary
        let status = status(link)
        let last = summary?.lastMessage
        let failures = badge(summary?.unseenFailures ?? 0, "まだ見ていない失敗")
        let unread = badge(summary?.unread ?? 0, "未読")
        let time = last.map { ListTime.format($0.at, now: now, calendar: calendar) } ?? ""
        let spoken = [name, status.text, status.detail, last?.text, time, failures?.accessibilityLabel,
            unread?.accessibilityLabel]
        return AgentRowProps(
            id: agent.origin.absoluteString,
            name: name,
            avatar: avatar(agent, name),
            status: status,
            lastMessage: last?.text ?? "",
            time: time,
            failures: failures,
            unread: unread,
            action: link.link == .signedOut ? .signInAgainRequested(agent.origin) : .agentOpened(agent.origin),
            accessibilityLabel: spoken.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "、"))
    }

    static func status(_ link: AgentConnection) -> StatusProps {
        switch link.link {
        case .connecting:
            return StatusProps(mark: .dot, tone: .muted, text: "つないでいる")
        case .unreachable:
            return StatusProps(mark: .warning, tone: .warning, text: "つながらない")
        case .signedOut:
            return StatusProps(mark: .warning, tone: .warning, text: "ログインし直す")
        case .live:
            switch link.summary?.state ?? .waiting {
            case .waiting:
                return StatusProps(mark: .dot, tone: .muted, text: "待っている")
            case .thinking:
                return StatusProps(mark: .dot, tone: .info, text: "考えている")
            case .tool(let tool):
                return StatusProps(mark: .dot, tone: .info, text: "ツールを使っている", detail: tool.isEmpty ? nil : tool)
            case .approval(let pending):
                return StatusProps(mark: .pause, tone: .info, text: "止まって待っている ・ 承認 \(pending)")
            }
        }
    }

    private static func badge(_ count: Int, _ what: String) -> BadgeProps? {
        guard count > 0 else { return nil }
        return BadgeProps(text: count > 99 ? "99+" : String(count), accessibilityLabel: "\(what) \(count)")
    }

    private static func avatar(_ agent: SavedAgent, _ name: String) -> AvatarProps {
        let url = agent.iconPath.flatMap { URL(string: $0, relativeTo: agent.origin)?.absoluteURL }
        return AvatarProps(url: url, initial: String(name.prefix(1)))
    }

    private static func add(_ form: AddForm) -> AddAgentProps {
        let busy: Bool
        switch form.step {
        case .editing: busy = false
        case .checking, .signingIn: busy = true
        }
        let problem: String? =
            switch form.problem {
            case nil: nil
            case .notHTTPS: "https:// で始まる、Web の画面を開くときの URL を入れてください。"
            case .notFound: "この URL には penelope が見つかりません。Web の画面を開くときの URL を入れてください。"
            case .alreadyAdded: "この URL のエージェントは、もう足してあります。"
            case .signInFailed: "ログインできませんでした。もう一度試してください。"
            }
        let filled = !form.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return AddAgentProps(
            text: form.text,
            placeholder: "https://",
            help: "Web の画面を開くときの URL。次に GitHub でログインします。",
            problem: problem,
            busy: busy,
            submit: ActionProps(label: "ログインに進む", event: .addSubmitted, enabled: filled && !busy))
    }

    private static func settings(_ state: AppState) -> SettingsProps {
        let rows = (state.agents ?? []).map { agent in
            let name = AppMediator.displayName(agent, agent.origin)
            let host = agent.origin.host ?? agent.origin.absoluteString
            let detail: String =
                switch state.links[agent.origin]?.link {
                case .unreachable: "\(host) ・ つながらない"
                case .signedOut: "\(host) ・ ログインし直す"
                default: host
                }
            return SettingsRowProps(
                id: agent.origin.absoluteString, name: name, avatar: avatar(agent, name), detail: detail,
                remove: ActionProps(label: "外す", event: .removeRequested(agent.origin)),
                removeAccessibilityLabel: "\(name)を外す")
        }
        return SettingsProps(
            caption: rows.count > 1 ? "エージェント ・ 長押しで並べ替え" : "エージェント",
            rows: rows,
            add: ActionProps(label: "エージェントを足す", event: .addAgentRequested))
    }

    private static func agentScreen(_ state: AppState) -> AgentScreenProps? {
        guard case .agent(let origin) = state.screens.last else { return nil }
        return AgentScreenProps(
            title: AppMediator.displayName(state.agent(origin), origin),
            message: "会話は次の版で、ここに出ます。それまでは Web の画面で話してください。",
            web: ActionProps(label: "Web で開く", event: .webRequested(origin)))
    }

    private static func alert(_ state: AppState) -> AlertProps? {
        if let origin = state.removing {
            let name = AppMediator.displayName(state.agent(origin), origin)
            return AlertProps(
                title: "\(name)を外しますか。",
                message: "この iPhone からログインの情報が消えます。",
                actions: [
                    .init(label: "外す", event: .removeConfirmed, role: .destructive),
                    .init(label: "やめる", event: .removeCancelled, role: .cancel),
                ])
        }
        switch state.notice {
        case nil:
            return nil
        case .signInFailed(let name):
            return AlertProps(
                title: "\(name)にログインできませんでした。",
                message: "もう一度、行を押してログインし直してください。",
                actions: [.init(label: "閉じる", event: .noticeDismissed, role: .cancel)])
        case .revocationUnconfirmed(let name):
            return AlertProps(
                title: "\(name)を外しました。",
                message: "ただ、\(name)のサーバーでこの iPhone のログインを取り消せたかを確かめられませんでした。\(name)の Web の設定の「iPhone の端末」から失効させてください。",
                actions: [.init(label: "閉じる", event: .noticeDismissed, role: .cancel)])
        }
    }
}

/// How the list writes when something was said: the time today, 「昨日」 the day before, the date before that.
enum ListTime {
    static func format(_ date: Date, now: Date, calendar: Calendar) -> String {
        let day = calendar.startOfDay(for: date)
        let today = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: day, to: today).day ?? 0
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let year = parts.year ?? 0
        let month = parts.month ?? 0
        let dayOfMonth = parts.day ?? 0
        if days <= 0 {
            let minute = parts.minute ?? 0
            return "\(parts.hour ?? 0):\(minute < 10 ? "0" : "")\(minute)"
        }
        if days == 1 { return "昨日" }
        if year == calendar.component(.year, from: now) { return "\(month)/\(dayOfMonth)" }
        return "\(year)/\(month)/\(dayOfMonth)"
    }
}
