// The Web UI: who she is from the settings, the login when there is no
// session, and otherwise the conversation kept up to date by the stream.
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import jaJP from "@astryxdesign/core/locales/ja-JP.generated.js";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";

import type { AgentResponse } from "@penelope/contract";

import { type Api, createApi, type Fetch, Unauthorized } from "../model/api.ts";
import { Outbox } from "../model/outbox.ts";
import { browserPush, type PushPlatform } from "../model/push.ts";
import { currentFlow, FACE_RESET_MS, faceOf, initialState, reduce, statusOf, subAgentsOf } from "../model/store.ts";
import { openStream } from "../model/stream.ts";
import { AgentContext } from "./agent.tsx";
import { Desktop } from "./Desktop.tsx";
import { Login } from "./Login.tsx";
import { useNotices } from "./Notices.tsx";
import { Phone } from "./Phone.tsx";

/** Below this width the phone's screen is shown. */
const PHONE = "(max-width: 767px)";

export type AppProps = {
  fetch: Fetch;
  /** Waits between tries of the stream. The tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The browser's service worker and Push API, for the notices. The tests give their own. */
  push?: PushPlatform;
};

export function App({ fetch, sleep, push }: AppProps) {
  const api = useMemo<Api>(() => createApi(fetch), [fetch]);
  const [state, dispatch] = useReducer(reduce, initialState);
  const [agent, setAgent] = useState<AgentResponse>({ name: "" });
  const outbox = useMemo(() => new Outbox({ send: (text, files) => api.send(text, files), dispatch }), [api]);
  const phone = useMediaQuery(PHONE);
  const opened = useRef(0);

  useEffect(() => {
    api.agent().then(setAgent, () => {});
  }, [api]);
  useEffect(() => {
    if (agent.name !== "") document.title = agent.name;
  }, [agent.name]);

  const readHistory = useCallback(async () => {
    try {
      const page = await api.history();
      dispatch({ type: "history", entries: page.entries, ...(page.before === undefined ? {} : { before: page.before }) });
      return true;
    } catch (error) {
      if (error instanceof Unauthorized) dispatch({ type: "unauthorized" });
      return false;
    }
  }, [api]);

  // The sub-agents outlive what the stream replays: read on each connection, then kept by the stream.
  const readAgents = useCallback(async () => {
    try {
      const { agents } = await api.agents();
      dispatch({ type: "agents", agents });
    } catch (error) {
      if (error instanceof Unauthorized) dispatch({ type: "unauthorized" });
    }
  }, [api]);

  // The count of the failures not seen: read on each connection, then kept by the stream.
  const readUnseen = useCallback(async () => {
    try {
      const { unseen } = await api.recordUnseen();
      dispatch({ type: "unseen", unseen });
    } catch (error) {
      if (error instanceof Unauthorized) dispatch({ type: "unauthorized" });
    }
  }, [api]);

  // The history first: it also tells whether there is a session.
  useEffect(() => {
    void readHistory();
  }, [readHistory]);

  const signedIn = state.signedIn === true;
  const platform = useMemo(() => push ?? browserPush(), [push]);
  const notices = useNotices(api, platform, signedIn);
  useEffect(() => {
    if (!signedIn) return;
    const stream = openStream({
      fetch,
      ...(sleep ? { sleep } : {}),
      onOpen: () => {
        dispatch({ type: "stream-open" });
        outbox.online();
        void readAgents();
        void readUnseen();
        // What came while the line was down and is no longer kept for the replay.
        if (opened.current++ > 0) void readHistory();
      },
      onEvent: (event) => dispatch({ type: "stream", event }),
      onDown: () => {
        outbox.offline();
        dispatch({ type: "connection", state: "offline" });
      },
      onUnauthorized: () => dispatch({ type: "unauthorized" }),
    });
    return () => stream.close();
  }, [signedIn, fetch, sleep, outbox, readHistory, readAgents, readUnseen]);

  const before = state.before;
  const onOlder = useMemo(
    () =>
      before === undefined
        ? undefined
        : async () => {
            const page = await api.history(before);
            dispatch({ type: "history", entries: page.entries, older: true, ...(page.before === undefined ? {} : { before: page.before }) });
          },
    [api, before],
  );

  // Kept the same across renders: a place that reads the backend does not read it again for each render.
  const onUnauthorized = useCallback(() => dispatch({ type: "unauthorized" }), []);
  const onSeen = useCallback(() => dispatch({ type: "unseen", unseen: 0 }), []);
  // The page that starts with a reply the activity record points at; the older pages go on where they were.
  const onJump = useCallback(
    async (at: string) => {
      const page = await api.history(at);
      dispatch({ type: "history", entries: page.entries });
    },
    [api],
  );

  // Read the clock again while the face shown would go back to neutral.
  const now = useClock(faceOf(state, Date.now()) === undefined ? undefined : FACE_RESET_MS);
  const status = statusOf(state);
  const busy = status.kind === "thinking" || status.kind === "tool";
  const screen = {
    items: state.items,
    busy,
    offline: state.connection === "offline",
    onSend: (text: string, files: File[]) => outbox.submit({ text, files, duringTurn: busy }),
    onOlder,
    onRead: api.markRead,
    status,
    flow: currentFlow(state),
    subAgents: subAgentsOf(state),
    expression: faceOf(state, now),
    notices,
    onLogout: () => {
      void api.logout().finally(() => dispatch({ type: "unauthorized" }));
    },
    api,
    onUnauthorized,
    unseen: state.unseen,
    recordChanges: state.recordChanges,
    onSeen,
    onJump,
  };

  return (
    <Theme theme={neutralTheme} mode="system">
      <InternationalizationProvider locale="ja-JP" messages={{ "ja-JP": jaJP }}>
        <AgentContext.Provider value={agent}>
          {state.signedIn === false ? <Login /> : state.signedIn === undefined ? null : phone ? <Phone {...screen} /> : <Desktop {...screen} />}
        </AgentContext.Provider>
      </InternationalizationProvider>
    </Theme>
  );
}

/** The time now, read again every `everyMs` while it is given. */
function useClock(everyMs: number | undefined): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (everyMs === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), Math.min(everyMs, 15_000));
    return () => clearInterval(timer);
  }, [everyMs]);
  return Math.max(now, Date.now());
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}
