import { AppShell } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { SideNav } from "@astryxdesign/core/SideNav";
import { useState, useSyncExternalStore } from "react";

import type { Api } from "../model/api.ts";
import { AgentAvatar, useAgent } from "./agent.tsx";
import { MenuIcon } from "./icons.tsx";
import { MemoryPlace } from "./memory/Memory.tsx";
import { PlaceItems } from "./places.tsx";
import { RecordPlace } from "./Record.tsx";
import { useRoute } from "./route.ts";
import { Schedules } from "./Schedules.tsx";
import { Settings } from "./Settings.tsx";
import { StatusPage } from "./StatusPage.tsx";
import { words } from "./words.ts";

const phone = () => window.matchMedia("(max-width: 767px)");
const subscribe = (onChange: () => void) => {
  const list = phone();
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
};

export function PersonalPage({ api, unseen, onSeen, onUnauthorized, onLogout }: {
  api: Api;
  unseen: number;
  onSeen: () => void;
  onUnauthorized: () => void;
  onLogout: () => void;
}) {
  const agent = useAgent();
  const [route, go] = useRoute();
  const [menu, setMenu] = useState(false);
  const compact = useSyncExternalStore(subscribe, () => phone().matches);
  const count = route.place === "log" ? 0 : unseen;
  const places = (
    <PlaceItems place={route.place} unseen={count} onChange={(place) => { go({ place }); setMenu(false); }} />
  );
  const logout = <Button label={words.logout} variant="ghost" onClick={onLogout} />;
  const content = (
    <main className="personal-main">
      <header className="personal-header">
        {compact && (
          <span className="phone-menu">
            <IconButton icon={<Icon icon={MenuIcon} />} label={count > 0 ? words.record.menuLabel(count) : words.menu} onClick={() => setMenu(true)} />
            {count > 0 && <span className="phone-menu-count" aria-hidden><Badge variant="error" label={count > 99 ? "99+" : String(count)} /></span>}
          </span>
        )}
        <AgentAvatar size={36} />
        <span>{agent.name}</span>
      </header>
      {route.place === "memory" && <MemoryPlace api={api} onUnauthorized={onUnauthorized} page={route.page} readOnly={compact} />}
      {route.place === "log" && <RecordPlace api={api} onUnauthorized={onUnauthorized} page={route.page} onSeen={onSeen} />}
      {route.place === "status" && <StatusPage api={api} onUnauthorized={onUnauthorized} />}
      {route.place === "events" && <Schedules api={api} onUnauthorized={onUnauthorized} />}
      {route.place === "settings" && <Settings api={api} onUnauthorized={onUnauthorized} agentName={agent.name} />}
    </main>
  );
  return compact ? (
    <>
      {content}
      <MobileNav isOpen={menu} onOpenChange={setMenu} header={agent.name} side="start">
        {places}
        {logout}
      </MobileNav>
    </>
  ) : (
    <AppShell sideNav={<SideNav aria-label="場所" footer={logout}>{places}</SideNav>} mobileNav={false}>
      {content}
    </AppShell>
  );
}
