import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import jaJP from "@astryxdesign/core/locales/ja-JP.generated.js";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { createApi, type Fetch } from "../model/api.ts";
import { Session, type Source } from "../model/session.ts";
import { House } from "./House.tsx";
import { Login } from "./Login.tsx";
import { words } from "./words.ts";

export type AppProps = {
  fetch: Fetch;
  /** The browser's EventSource. The tests give their own. */
  open: (url: string) => Source;
  /** Waits before a refused stream is tried again. The tests do not wait. */
  wait?: (ms: number) => Promise<void>;
};

export function App({ fetch, open, wait }: AppProps) {
  const session = useMemo(() => new Session({ api: createApi(fetch), open, ...(wait ? { wait } : {}) }), [fetch, open, wait]);
  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);

  return (
    <Theme theme={neutralTheme} mode="system">
      <InternationalizationProvider locale="ja-JP" messages={{ "ja-JP": jaJP }}>
        {snapshot.signedIn === false ? (
          <Login />
        ) : snapshot.house === undefined ? (
          <Center minHeight="100dvh" padding={6}>
            <main className="opening">
              <p role="status" className={snapshot.line.kind === "connecting" ? "muted" : undefined}>
                {snapshot.line.kind === "connecting" ? words.opening : words.refused}
              </p>
              {snapshot.line.kind === "connecting" ? null : <Button label={words.retry} variant="secondary" onClick={() => session.retry()} />}
            </main>
          </Center>
        ) : (
          <House session={session} snapshot={snapshot} house={snapshot.house} />
        )}
      </InternationalizationProvider>
    </Theme>
  );
}
