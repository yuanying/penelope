import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import jaJP from "@astryxdesign/core/locales/ja-JP.generated.js";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentResponse } from "@penelope/contract";

import { createApi, type Fetch, Unauthorized } from "../model/api.ts";
import { AgentContext } from "./agent.tsx";
import { Login } from "./Login.tsx";
import { PersonalPage } from "./PersonalPage.tsx";

export function App({ fetch }: { fetch: Fetch }) {
  const api = useMemo(() => createApi(fetch), [fetch]);
  const [agent, setAgent] = useState<AgentResponse>({ name: "" });
  const [session, setSession] = useState<"loading" | "signed-in" | "signed-out" | "failed">("loading");
  const [unseen, setUnseen] = useState(0);

  useEffect(() => { void api.agent().then(setAgent, () => {}); }, [api]);
  useEffect(() => { if (agent.name !== "") document.title = agent.name; }, [agent.name]);

  const onUnauthorized = useCallback(() => setSession("signed-out"), []);
  const onSeen = useCallback(() => setUnseen(0), []);
  const readSession = useCallback(async () => {
    try {
      setUnseen((await api.recordUnseen()).unseen);
      setSession((current) => current === "signed-out" ? current : "signed-in");
    } catch (error) {
      if (error instanceof Unauthorized) onUnauthorized();
      else setSession((current) => current === "loading" ? "failed" : current);
    }
  }, [api, onUnauthorized]);
  useEffect(() => { void readSession(); }, [readSession]);
  useEffect(() => {
    if (session !== "signed-in") return;
    const refresh = () => { void readSession(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [readSession, session]);

  return (
    <Theme theme={neutralTheme} mode="system">
      <InternationalizationProvider locale="ja-JP" messages={{ "ja-JP": jaJP }}>
        <AgentContext.Provider value={agent}>
          {session === "signed-out" && <Login />}
          {session === "signed-in" && <PersonalPage api={api} unseen={unseen} onSeen={onSeen} onUnauthorized={onUnauthorized}
            onLogout={() => { void api.logout().then(onUnauthorized, onUnauthorized); }} />}
          {session === "failed" && <Center minHeight="100dvh" padding={6}>
            <div className="login"><p role="alert">個人のページを開けませんでした。</p><Button label="読み直す" onClick={() => void readSession()} /></div>
          </Center>}
        </AgentContext.Provider>
      </InternationalizationProvider>
    </Theme>
  );
}
