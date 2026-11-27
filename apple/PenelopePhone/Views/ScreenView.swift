import PenelopeCore
import SwiftUI

/// Draws whichever screens the drawing parameters say are up: 「みんな」 at the bottom, the others over it.
struct ScreenView: View {
    let model: ScreenModel

    var body: some View {
        let props = model.props
        let sinks = model.sinks
        NavigationStack(path: path(props.path, sinks.navigation)) {
            EveryoneView(props: props.everyone, sinks: sinks.everyone)
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: RouteProps.self) { route in
                    switch route {
                    case .add:
                        AddAgentView(props: props.add, send: sinks.add)
                    case .settings:
                        SettingsView(props: props.settings, sinks: sinks.settings)
                    case .agent:
                        if let agent = props.agent { AgentScreenView(props: agent, send: sinks.agent) }
                    }
                }
        }
        .tint(Palette.text)
        .alert(
            props.alert?.title ?? "", isPresented: .constant(props.alert != nil), presenting: props.alert
        ) { alert in
            ForEach(Array(alert.actions.enumerated()), id: \.offset) { _, action in
                Button(action.label, role: role(action.role)) { sinks.alert(action.event) }
            }
        } message: { alert in
            Text(alert.message)
        }
    }

    /// The navigation only reports going back; going forward is the mediator's to decide, and arrives in the path.
    private func path(_ path: [RouteProps], _ send: EventSink) -> Binding<[RouteProps]> {
        Binding(
            get: { path },
            set: { next in
                if next.count < path.count { send(.navigatedBack(depth: next.count)) }
            })
    }

    private func role(_ role: AlertProps.Action.Role) -> ButtonRole? {
        switch role {
        case .normal: nil
        case .cancel: .cancel
        case .destructive: .destructive
        }
    }
}
