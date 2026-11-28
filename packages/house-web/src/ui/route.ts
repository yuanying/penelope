import { useCallback, useSyncExternalStore } from "react";

export type Route = { at: "plan" } | { at: "talk"; room?: string } | { at: "peek"; room: string } | { at: "dm"; agent: string };

export function parseRoute(hash: string): Route {
  const [, name, id] = hash.split("/");
  if (name === "talk" && !id) return { at: "talk" };
  if ((name === "talk" || name === "peek" || name === "dm") && id) {
    try {
      const target = decodeURIComponent(id);
      return name === "dm" ? { at: name, agent: target } : { at: name, room: target };
    } catch {
      return { at: "plan" };
    }
  }
  return { at: "plan" };
}

export function hashOf(route: Route): string {
  if (route.at === "plan") return "#/";
  const pane = `#/${route.at}`;
  const id = route.at === "dm" ? route.agent : route.room;
  return id === undefined ? pane : `${pane}/${encodeURIComponent(id)}`;
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
