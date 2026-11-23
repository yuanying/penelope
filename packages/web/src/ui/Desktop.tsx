// The PC's screen (docs/design/README.md, 3): the places on the left, the
// conversation in the middle, the agent now on the right.
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutPanel } from "@astryxdesign/core/Layout";
import { SideNav } from "@astryxdesign/core/SideNav";
import { useState } from "react";

import type { Api } from "../model/api.ts";
import type { FlowItem, Status, SubAgentView } from "../model/store.ts";
import { AgentAvatar, useAgent } from "./agent.tsx";
import { StatusLabel } from "./Now.tsx";
import { LogoutIcon } from "./icons.tsx";
import { MemoryPlace } from "./memory/Memory.tsx";
import { type Notices, NoticesButton } from "./Notices.tsx";
import { AgentNow } from "./Panel.tsx";
import { RecordPlace } from "./Record.tsx";
import { type Route, useRoute } from "./route.ts";
import { Schedules } from "./Schedules.tsx";
import { Settings } from "./Settings.tsx";
import { SubAgentCount } from "./SubAgents.tsx";
import { PlaceItems } from "./places.tsx";
import { Talk, type TalkProps } from "./Talk.tsx";
import { words } from "./words.ts";

export type ScreenProps = TalkProps & {
  status: Status;
  flow: FlowItem[];
  subAgents: SubAgentView[];
  expression: string | undefined;
  notices: Notices;
  onLogout: () => void;
  /** For the places that read the backend themselves. */
  api: Api;
  onUnauthorized: () => void;
  /** The failures of the activity record not seen. */
  unseen: number;
  /** Changes whenever the stream says something that may have changed the activity record. */
  recordChanges: number;
  /** The backend was told the owner looked at the activity record. */
  onSeen: () => void;
};

/** What the middle of the screen shows for the route: the same on a PC and a phone. */
export function PlaceBody({ route, props, topInset = false }: { route: Route; props: ScreenProps; topInset?: boolean }) {
  const agent = useAgent();
  switch (route.place) {
    case "settings":
      return <Settings api={props.api} onUnauthorized={props.onUnauthorized} agentName={agent.name} topInset={topInset} />;
    case "events":
      return <Schedules api={props.api} onUnauthorized={props.onUnauthorized} topInset={topInset} />;
    case "log":
      return (
        <RecordPlace
          api={props.api}
          onUnauthorized={props.onUnauthorized}
          page={route.page}
          unseen={props.unseen}
          changes={props.recordChanges}
          onSeen={props.onSeen}
          topInset={topInset}
        />
      );
    case "talk":
      return null;
    case "memory":
      return <MemoryPlace api={props.api} onUnauthorized={props.onUnauthorized} page={route.page} topInset={topInset} />;
  }
}

export function Desktop(props: ScreenProps) {
  const agent = useAgent();
  const [route, go] = useRoute();
  const [open, setOpen] = useState(true);
  // The rail starts folded to its icons, to leave the width to the conversation.
  const [folded, setFolded] = useState(true);
  const logout = folded ? (
    <IconButton icon={<Icon icon={LogoutIcon} />} label={words.logout} variant="ghost" size="sm" onClick={props.onLogout} />
  ) : (
    <Button label={words.logout} variant="ghost" size="sm" onClick={props.onLogout} />
  );
  const footer = (
    <div className={folded ? "rail-footer rail-footer-folded" : "rail-footer"}>
      <NoticesButton notices={props.notices} compact={folded} />
      {logout}
    </div>
  );
  const nav = (
    <SideNav aria-label="場所" collapsible={{ isCollapsed: folded, onCollapsedChange: setFolded }} footer={footer}>
      <PlaceItems place={route.place} onChange={(place) => go({ place } as Route)} unseen={route.place === "log" ? 0 : props.unseen} folded={folded} />
    </SideNav>
  );
  const main = (
    <div className="desktop-main">
      <header className="desktop-header">
        <button type="button" className="agent-toggle" aria-expanded={open} aria-label={words.togglePanel} onClick={() => setOpen(!open)}>
          <StatusLabel status={props.status} />
          {/* Where the panel would show them. */}
          {open ? null : <SubAgentCount agents={props.subAgents} />}
          <span className="agent-toggle-name">{agent.name}</span>
          <AgentAvatar size={36} expression={props.expression} />
        </button>
      </header>
      {route.place === "talk" ? <Talk {...props} jump={route.reply} /> : <PlaceBody route={route} props={props} />}
    </div>
  );
  return (
    <AppShell sideNav={nav} mobileNav={false}>
      <Layout
        content={main}
        end={
          open ? (
            <LayoutPanel label={words.panel} role="complementary" width={400} hasDivider>
              <AgentNow status={props.status} flow={props.flow} subAgents={props.subAgents} expression={props.expression} avatarSize={128} />
            </LayoutPanel>
          ) : null
        }
      />
    </AppShell>
  );
}
