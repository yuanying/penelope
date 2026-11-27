import PenelopeCore

/// 「みんな」, the list of the agents. Each part that raises something is a child of its own, so that an event
/// says where it came from.
@MainActor
final class EveryoneComponent: Component {
    /// 「＋」 and the gear beside the heading.
    let header = Component(name: "everyone.header")
    /// The button of the empty list.
    let empty = Component(name: "everyone.empty")
    /// The agents' rows.
    let rows = Component(name: "everyone.rows")

    init() {
        super.init(name: "everyone")
        adopt(header)
        adopt(empty)
        adopt(rows)
    }
}

/// 「エージェントを足す」.
@MainActor
final class AddAgentComponent: Component {
    /// The URL field and 「ログインに進む」.
    let form = Component(name: "add.form")

    init() {
        super.init(name: "add")
        adopt(form)
    }
}

/// The app's own settings.
@MainActor
final class SettingsComponent: Component {
    /// The agents' rows: 「外す」 and the reordering.
    let rows = Component(name: "settings.rows")
    /// 「エージェントを足す」 at the bottom.
    let footer = Component(name: "settings.footer")

    init() {
        super.init(name: "settings")
        adopt(rows)
        adopt(footer)
    }
}

/// One agent's screen. For now it only says the conversation is coming, and opens her Web UI.
@MainActor
final class AgentComponent: Component {
    init() {
        super.init(name: "agent")
    }
}
