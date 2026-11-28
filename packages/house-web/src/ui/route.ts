import { useCallback, useSyncExternalStore } from "react";

export type Route = { at: "plan" } | { at: "talk"; room?: string } | { at: "peek"; room: string };

export function parseRoute(hash: string): Route {
  const [, name, room] = hash.split("/");
  if (name === "talk" && !room) return { at: "talk" };
  if ((name === "talk" || name === "peek") && room) {
    try {
      return { at: name, room: decodeURIComponent(room) };
    } catch {
      return { at: "plan" };
    }
  }
  return { at: "plan" };
}

function hashOf(route: Route): string {
  if (route.at === "plan") return "#/";
  const pane = `#/${route.at}`;
  return route.room === undefined ? pane : `${pane}/${encodeURIComponent(route.room)}`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** `replace` leaves no step for the browser's back button to return to. */
export function useRoute(): [Route, (route: Route, replace?: boolean) => void] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const go = useCallback((route: Route, replace = false) => {
    if (replace) {
      window.history.replaceState(null, "", hashOf(route));
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else {
      window.location.hash = hashOf(route);
    }
  }, []);
  return [parseRoute(hash), go];
}
