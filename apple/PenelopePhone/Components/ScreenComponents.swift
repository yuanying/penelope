import PenelopeCore

/// 「みんな」, the list of the agents. Each part that raises something is a child of its own, so that an event
/// says where it came from.
@MainActor
final class EveryoneComponent: Component {
    /// 「＋」 and the gear beside the heading.
    let header = Component(name: "everyone.header")
    /// The button of the empty list.
    let empty = Component(name: "everyone.empty")

    init() {
        super.init(name: "everyone")
        adopt(header)
        adopt(empty)
    }
}
