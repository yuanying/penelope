import PenelopeCore
import SwiftUI

/// 「エージェントを足す」: the URL of her Web UI, then her backend's sign-in (design guide 18 章).
struct AddAgentView: View {
    let props: AddAgentProps
    let send: EventSink

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("エージェントの URL")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.text)
            TextField(
                props.placeholder,
                text: Binding(get: { props.text }, set: { send(.addURLChanged($0)) })
            )
            .keyboardType(.URL)
            .textContentType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.go)
            .onSubmit { if props.submit.enabled { send(props.submit.event) } }
            .disabled(props.busy)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(props.problem == nil ? Palette.border : Palette.danger, lineWidth: 1)
            }
            .accessibilityLabel("エージェントの URL")
            if let problem = props.problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(Palette.danger)
            } else {
                Text(props.help)
                    .font(.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
            PrimaryButton(props: props.submit, send: send, busy: props.busy)
                .padding(.top, 8)
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Palette.background)
        .navigationTitle("エージェントを足す")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: props.problem) { _, problem in
            // The field's message is read out when it turns up, as role="alert" is on the Web.
            if let problem { AccessibilityNotification.Announcement(problem).post() }
        }
    }
}

/// The app's own settings: the agents, to reorder or take off, and 「エージェントを足す」.
struct SettingsView: View {
    let props: SettingsProps
    let sinks: SettingsSinks

    var body: some View {
        List {
            Section {
                ForEach(props.rows) { row in
                    HStack(spacing: 12) {
                        AvatarView(props: row.avatar, size: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.name).foregroundStyle(Palette.text).lineLimit(1)
                            Text(row.detail)
                                .font(.caption)
                                .foregroundStyle(Palette.textSecondary)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Button(row.remove.label) { sinks.rows(row.remove.event) }
                            .buttonStyle(.bordered)
                            .font(.subheadline)
                            .accessibilityLabel(row.removeAccessibilityLabel)
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(Palette.textSecondary)
                            .accessibilityHidden(true)
                    }
                    .frame(minHeight: 44)
                    .listRowBackground(Palette.background)
                }
                .onMove { from, to in sinks.rows(.agentsMoved(from: Array(from), to: to)) }
            } header: {
                Text(props.caption)
            }
            Section {
                Button {
                    sinks.footer(props.add.event)
                } label: {
                    Text(props.add.label)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Palette.text)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(Palette.neutral, in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .listRowBackground(Palette.background)
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .navigationTitle("アプリの設定")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// One agent's screen, until her conversation comes in the next version.
struct AgentScreenView: View {
    let props: AgentScreenProps
    let send: EventSink

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text(props.message)
                .font(.subheadline)
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
            PrimaryButton(props: props.web, send: send).fixedSize()
            Spacer()
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity)
        .background(Palette.background)
        .navigationTitle(props.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
