import PenelopeCore
import SwiftUI

/// 「みんな」: the heading, and under it the agents or the empty list.
struct EveryoneView: View {
    let props: EveryoneProps
    let sinks: EveryoneSinks

    var body: some View {
        VStack(spacing: 0) {
            header
            switch props.body {
            case .blank:
                Spacer()
            case .empty(let empty):
                EmptyListView(props: empty, send: sinks.empty)
            case .rows(let rows):
                List(rows) { row in
                    Text(row.name).font(.headline)
                }
                .listStyle(.plain)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 0) {
            Text("みんな")
                .font(.largeTitle.bold())
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button {
                sinks.header(.addAgentRequested)
            } label: {
                Image(systemName: "plus").frame(width: 44, height: 44)
            }
            .accessibilityLabel("エージェントを足す")
            Button {
                sinks.header(.appSettingsRequested)
            } label: {
                Image(systemName: "gearshape").frame(width: 44, height: 44)
            }
            .accessibilityLabel("アプリの設定")
        }
        .font(.title3)
        .tint(Color.primary)
        .padding(.leading, 20)
        .padding(.trailing, 8)
        .padding(.top, 8)
    }
}

/// What the list shows when no agent has been added.
struct EmptyListView: View {
    let props: EmptyListProps
    let send: EventSink

    var body: some View {
        VStack(spacing: 12) {
            Spacer()
            Text(props.title).font(.headline)
            Text(props.message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                send(props.action.event)
            } label: {
                Text(props.action.label)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color(uiColor: .systemBackground))
                    .padding(.horizontal, 20)
                    .frame(minHeight: 44)
                    .background(Color.primary, in: Capsule())
            }
            .padding(.top, 8)
            Spacer()
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity)
    }
}

#Preview {
    EveryoneView(
        props: AppProps.root(AppState(agents: [])).everyone, sinks: EveryoneSinks())
}
