#if DEBUG
    import Foundation
    import PenelopeCore

    /// A made-up world for looking at the screens without a backend: start a debug build with the argument
    /// `-PenelopeDemo <scene>`. The names and hosts are made up (`example.com`); nothing is kept and nothing is sent.
    ///
    /// The scenes go through the real mediator: `script` is what the owner would have done after the launch.
    @MainActor
    final class DemoWorld: AppWorld {
        enum Scene: String {
            /// No agent yet.
            case empty
            /// Five agents in every state of the list.
            case list
            /// 「エージェントを足す」, empty.
            case add
            /// 「エージェントを足す」, after a URL where no penelope answers.
            case addError = "add-error"
            /// The app's settings over the five.
            case settings
        }

        /// The scene asked for by the launch arguments, if any.
        static var requested: Scene? {
            UserDefaults.standard.string(forKey: "PenelopeDemo").flatMap(Scene.init(rawValue:))
        }

        private let scene: Scene
        private let now = Date()
        private var lostOnce: Set<String> = []

        init(scene: Scene) {
            self.scene = scene
        }

        /// What the owner does after the launch, as events.
        var script: [AppEvent] {
            switch scene {
            case .empty, .list: []
            case .add: [.addAgentRequested]
            case .addError: [.addAgentRequested, .addURLChanged("https://www.example.com"), .addSubmitted]
            case .settings: [.appSettingsRequested]
            }
        }

        private struct Agent {
            var host: String
            var name: String
            var summary: AgentSummary?
            var signedOut = false
            /// Whether the stream is lost after its first summary, and then cannot be opened again.
            var lost = false
        }

        private var agents: [Agent] {
            let calendar = Calendar.current
            let today = { (minutesAgo: Double) in self.now.addingTimeInterval(-minutesAgo * 60) }
            let yesterday = calendar.date(byAdding: .day, value: -1, to: now)!
            let older = calendar.date(byAdding: .day, value: -6, to: now)!
            return [
                Agent(
                    host: "alpha.example.com", name: "アルファ",
                    summary: AgentSummary(
                        state: .tool("bash: kubectl get nodes -o wide"),
                        lastMessage: LastMessage(kind: .agent, at: today(3), text: "ノードは 5 台とも Ready だよ。いま Pod も見てる。"),
                        unread: 2, unseenFailures: 0)),
                Agent(
                    host: "bravo.example.com", name: "ブラボー",
                    summary: AgentSummary(
                        state: .thinking,
                        lastMessage: LastMessage(kind: .owner, at: today(32), text: "明日の予定を教えて"),
                        unread: 0, unseenFailures: 0)),
                Agent(
                    host: "charlie.example.com", name: "チャーリー",
                    summary: AgentSummary(
                        state: .waiting,
                        lastMessage: LastMessage(kind: .agent, at: yesterday, text: "了解。夜に整理しておく。"),
                        unread: 1, unseenFailures: 1)),
                Agent(
                    host: "delta.example.com", name: "デルタ",
                    summary: AgentSummary(
                        state: .waiting,
                        lastMessage: LastMessage(kind: .agent, at: older, text: "おやすみなさい。"),
                        unread: 0, unseenFailures: 0),
                    lost: true),
                Agent(host: "echo.example.com", name: "エコー", summary: nil, signedOut: true),
            ]
        }

        private func agent(_ origin: URL) -> Agent? {
            agents.first { $0.host == origin.host }
        }

        func loadAgents() -> [SavedAgent] {
            scene == .empty
                ? []
                : agents.map { SavedAgent(origin: URL(string: "https://\($0.host)")!, name: $0.name) }
        }

        func saveAgents(_ agents: [SavedAgent]) {}

        func profile(at origin: URL) async -> AgentProfile? {
            agent(origin).map { AgentProfile(name: $0.name, iconPath: nil) }
        }

        func signIn(to origin: URL) async -> SignInResult { .failed }

        func streamSummaries(at origin: URL, received: @escaping @MainActor (AgentSummary) -> Void) async -> StreamEnd {
            guard let agent = agent(origin), !agent.signedOut else { return .unauthorized }
            guard let summary = agent.summary, !lostOnce.contains(agent.host) else { return .failed }
            received(summary)
            if agent.lost {
                lostOnce.insert(agent.host)
                return .failed
            }
            // Open until it is closed.
            try? await Task.sleep(for: .seconds(60 * 60 * 24))
            return .failed
        }

        func forget(_ origin: URL) async -> Bool { false }

        func openInBrowser(_ url: URL) {}
    }
#endif
