// The activity record in the Web UI (docs/ui-api.md, "活動の記録";
// docs/design/README.md, 15): the count of the failures not seen, the list a
// day at a time, and each turn, night and closed sub-agent on its own page,
// reached by its address, and the way to and from the conversation.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { RecordDayResponse, RecordRow, RecordTurn } from "@penelope/contract";

import { App } from "../src/ui/App.tsx";
import { timeOf, words } from "../src/ui/words.ts";
import { FakeBackend } from "./fake-backend.ts";

const w = words.record;
const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
type HappyWindow = { happyDOM: { setViewport: (viewport: { width: number; height?: number }) => void } };

/** A local time on the fake backend's day, 2026-11-17. */
const at = (hour: number, minute: number, day = 17) => new Date(2026, 10, day, hour, minute).toISOString();

const turn = (id: string, hour: number, minute: number, extra: Partial<RecordTurn> = {}): RecordTurn => ({
  id,
  kind: "turn",
  at: at(hour, minute),
  agent: "main",
  started_at: at(hour, minute),
  ended_at: at(hour, minute + 1),
  seconds: 48,
  result: "done",
  triggers: [{ seq: 1, source: "cron", summary: "毎時の見回り" }],
  trigger_count: 1,
  tools: 3,
  replies: 0,
  ...extra,
});

const failed = turn("t-failed", 14, 12, {
  triggers: [{ seq: 1, source: "alertmanager", summary: "[FIRING warning] HighMemoryUsage" }],
  result: "failed",
  reason: "モデルの呼び出しが 3 回続けて落ちた",
  failed_at: at(14, 13),
});

const dayOf = (day: string, rows: RecordRow[], extra: Partial<RecordDayResponse> = {}): RecordDayResponse => ({
  day,
  rows,
  turns: rows.filter((r) => r.kind === "turn").length,
  failures: rows.filter((r) => r.failed_at !== undefined).length,
  agents: [],
  ...extra,
});

/** An IntersectionObserver the test drives: happy-dom lays nothing out, so nothing comes into sight by itself. */
const observers = new Set<{ callback: IntersectionObserverCallback; elements: Element[] }>();
class FakeObserver {
  private entry: { callback: IntersectionObserverCallback; elements: Element[] };
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, elements: [] };
    observers.add(this.entry);
  }
  observe(element: Element) {
    this.entry.elements.push(element);
  }
  disconnect() {
    observers.delete(this.entry);
  }
}
async function reachEnd() {
  await act(async () => {
    for (const { callback, elements } of [...observers])
      callback(elements.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry), {} as IntersectionObserver);
  });
}

const original = globalThis.IntersectionObserver;
beforeEach(() => {
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  cleanup();
  globalThis.IntersectionObserver = original;
  observers.clear();
  window.history.replaceState(null, "", "/");
  (window as unknown as HappyWindow).happyDOM.setViewport({ width: 1024 });
});

function start(backend: FakeBackend, hash = "") {
  window.history.replaceState(null, "", `/${hash}`);
  render(<App fetch={backend.fetch} sleep={sleep} />);
  return backend;
}

async function press(found: HTMLElement | Promise<HTMLElement>) {
  const element = await found;
  await act(async () => fireEvent.click(element));
}

/** Follows a link as the browser does: to its address after the #. */
async function follow(link: HTMLElement) {
  await act(async () => {
    window.location.hash = new URL((link as HTMLAnchorElement).href).hash;
  });
}

const list = () => screen.findByRole("region", { name: w.title });
const rowOf = async (text: string | RegExp) => (await within(await list()).findByText(text)).closest("li") as HTMLElement;

describe("the count of the failures not seen", () => {
  it("is on the activity record's place, and follows the stream", async () => {
    const backend = new FakeBackend();
    backend.unseen = 2;
    start(backend);
    await backend.connected();
    assert.ok(await screen.findByRole("button", { name: w.railLabel(2) }));
    await act(async () => backend.send({ event: "record", data: { unseen: 3 } }));
    assert.ok(await screen.findByRole("button", { name: w.railLabel(3) }));
    await act(async () => backend.send({ event: "record", data: { unseen: 0 } }));
    assert.ok(await screen.findByRole("button", { name: words.places.log }));
  });

  it("is on the phone's menu button", async () => {
    (window as unknown as HappyWindow).happyDOM.setViewport({ width: 390, height: 844 });
    const backend = new FakeBackend();
    backend.unseen = 4;
    start(backend);
    await backend.connected();
    assert.ok(await screen.findByRole("button", { name: w.menuLabel(4) }));
  });

  // Opening the place tells the backend once; the failures since she looked before are told and marked.
  it("goes when the place is opened, which tells of the failures since and marks them new", async () => {
    const backend = new FakeBackend();
    backend.unseen = 1;
    backend.previousSeenAt = at(10, 0);
    const old = turn("t-old", 9, 30, { result: "failed", reason: "前のもの", failed_at: at(9, 31) });
    backend.recordDays.set(backend.today, dayOf(backend.today, [failed, old]));
    start(backend);
    await backend.connected();
    await press(screen.findByRole("button", { name: w.railLabel(1) }));
    assert.ok(await screen.findByText(w.unseenBanner(1)));
    assert.equal(backend.seenTold, 1);
    assert.ok(within(await rowOf("[FIRING warning] HighMemoryUsage")).getByText(w.fresh));
    assert.equal(within(await rowOf(/前のもの/)).queryByText(w.fresh), null);
    assert.equal(screen.queryByRole("button", { name: /まだ見ていない/ }), null);
  });
});

describe("the list of the activity record", () => {
  it("heads each day with its turns and failures, and shows a failure with why it failed", async () => {
    const backend = new FakeBackend();
    backend.recordDays.set(backend.today, dayOf(backend.today, [failed, turn("t-1", 9, 0)]));
    start(backend, "#/record");
    const page = await list();
    assert.ok(await within(page).findByText("ターン 2 ・ 失敗 1"));
    assert.ok(within(page).getByRole("heading", { level: 2, name: /11月17日\(火\)/ }));
    const row = await rowOf("[FIRING warning] HighMemoryUsage");
    assert.ok(within(row).getByText("alertmanager"));
    assert.ok(within(row).getByText("失敗した ・ モデルの呼び出しが 3 回続けて落ちた"));
    assert.ok(within(row).getByRole("img", { name: w.failed }));
  });

  it("opens a folded hour in place", async () => {
    const backend = new FakeBackend();
    backend.recordDays.set(backend.today, dayOf(backend.today, [turn("t-2", 14, 40), turn("t-1", 14, 5)]));
    start(backend, "#/record");
    const hour = await within(await list()).findByRole("button", { name: /14時台/ });
    assert.equal(hour.getAttribute("aria-expanded"), "false");
    assert.equal(screen.queryByText("14:40"), null);
    await press(hour);
    assert.equal(hour.getAttribute("aria-expanded"), "true");
    assert.ok(screen.getByText("14:40"));
  });

  it("adds a turn to the list when the stream says one ended", async () => {
    const backend = new FakeBackend();
    backend.recordDays.set(backend.today, dayOf(backend.today, [failed]));
    start(backend, "#/record");
    await rowOf("[FIRING warning] HighMemoryUsage");
    await backend.connected();
    backend.recordDays.set(backend.today, dayOf(backend.today, [turn("t-new", 15, 0, { triggers: [{ seq: 9, source: "slack", summary: "新しいメンション" }] }), failed]));
    await act(async () => backend.send({ event: "activity", data: { agent: "main", activity: { kind: "turn_end", at: at(15, 1), turn_id: "t-new" } } }));
    assert.ok(await rowOf("新しいメンション"));
  });

  it("reads the day before when the end of the list comes into sight", async () => {
    const backend = new FakeBackend();
    backend.recordDays.set(backend.today, dayOf(backend.today, [failed], { before: "2026-11-15" }));
    backend.recordDays.set("2026-11-15", dayOf("2026-11-15", [turn("t-old", 9, 0, { at: at(9, 0, 15), triggers: [{ seq: 1, source: "self", summary: "前の日のこと" }] })]));
    start(backend, "#/record");
    await rowOf("[FIRING warning] HighMemoryUsage");
    assert.equal(screen.queryByText(w.footer), null);
    await reachEnd();
    assert.ok(await rowOf("前の日のこと"));
    assert.equal(backend.recordQueries.at(-1)?.get("day"), "2026-11-15");
    assert.ok(screen.getByText(w.footer));
  });

  it("asks for the failures only, and for one agent's rows", async () => {
    const backend = new FakeBackend();
    backend.recordDays.set(backend.today, dayOf(backend.today, [failed], { agents: ["renovate-review"] }));
    start(backend, "#/record");
    await rowOf("[FIRING warning] HighMemoryUsage");
    await press(screen.getByRole("button", { name: w.onlyFailures }));
    await waitFor(() => assert.equal(backend.recordQueries.at(-1)?.get("failed"), "1"));
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: w.who }), { target: { value: "renovate-review" } }));
    await waitFor(() => assert.equal(backend.recordQueries.at(-1)?.get("agent"), "renovate-review"));
    assert.equal(backend.recordQueries.at(-1)?.get("failed"), "1");
    assert.equal(backend.recordQueries.at(-1)?.get("tz"), Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("says there is nothing yet, with nothing to narrow", async () => {
    const backend = new FakeBackend();
    start(backend, "#/record");
    assert.ok(await screen.findByText(w.emptyTitle));
    assert.equal(screen.queryByRole("button", { name: w.onlyFailures }), null);
  });

  it("does not open a missed night", async () => {
    const backend = new FakeBackend();
    backend.recordDays.set(backend.today, dayOf(backend.today, [{ id: "m", kind: "missed_night", at: at(3, 0), scheduled_at: at(3, 0), failed_at: at(3, 1) }]));
    start(backend, "#/record");
    const row = await rowOf(w.missedNote("3:00"));
    assert.equal(row.querySelector("a"), null);
    assert.ok(within(row).getByRole("img", { name: w.missedNight }));
  });
});

describe("a turn of the activity record", () => {
  it("opens from its row at its own address, with what it did", async () => {
    const backend = new FakeBackend();
    backend.recordDays.set(backend.today, dayOf(backend.today, [failed]));
    backend.recordTurns.set(failed.id, {
      turn: failed,
      flow: [{ kind: "tool_call", at: at(14, 12), turn_id: failed.id, call_id: "c-1", name: "bash", arguments: { command: "kubectl top pods" } }],
      expired: false,
      replies: [],
    });
    start(backend, "#/record");
    await follow(within(await rowOf("[FIRING warning] HighMemoryUsage")).getByRole("link"));
    assert.equal(window.location.hash, "#/record/turns/t-failed");
    assert.ok(await screen.findByRole("heading", { level: 1, name: "alertmanager ・ [FIRING warning] HighMemoryUsage" }));
    assert.ok(screen.getByText(/kubectl top pods/));
    assert.ok(screen.getByText(w.noReplies));
    assert.ok(screen.getByText(w.toolTimes(3)));
  });

  // A result is read only when it is opened: the page does not carry outputs of tens of KB.
  it("reads a tool's result when it is opened, saying its size before", async () => {
    const backend = new FakeBackend();
    backend.recordTurns.set("t-1", {
      turn: turn("t-1", 9, 0),
      flow: [
        { kind: "tool_call", at: at(9, 0), turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "ls" } },
        { kind: "tool_result", at: at(9, 0), turn_id: "t-1", call_id: "c-1", is_error: false, lines: 128, bytes: 3174 },
      ],
      expired: false,
      replies: [],
    });
    backend.recordResults.set("t-1/c-1", "the whole output");
    start(backend, "#/record/turns/t-1");
    const open = await screen.findByRole("button", { name: w.openResult(128, "3.1 KB") });
    assert.equal(screen.queryByText("the whole output"), null);
    await press(open);
    assert.ok(await screen.findByText("the whole output"));
  });

  it("says its flow is gone after 30 days", async () => {
    const backend = new FakeBackend();
    backend.recordTurns.set("t-1", { turn: turn("t-1", 9, 0), flow: [], expired: true, replies: [] });
    start(backend, "#/record/turns/t-1");
    assert.ok(await screen.findByText(w.expired));
  });

  it("goes to its reply in the conversation, reading the page of the history that starts with it", async () => {
    const backend = new FakeBackend();
    backend.recordTurns.set("t-1", {
      turn: turn("t-1", 9, 0, { replies: 1 }),
      flow: [],
      expired: false,
      replies: [{ id: "r-old", at: at(9, 1), text: "古い返事", history_before: "cursor-1" }],
    });
    backend.historyPages.set("cursor-1", [{ kind: "agent", id: "r-old", at: at(9, 1), text: "古い返事", agent: "main", turn_id: "t-1" }]);
    start(backend, "#/record/turns/t-1");
    await follow(await screen.findByRole("link", { name: w.toTalk }));
    await backend.connected();
    assert.ok(await within(await screen.findByRole("log")).findByText("古い返事"));
    assert.deepEqual(backend.historyBefores, ["cursor-1"]);
  });
});

describe("the other pages of the activity record", () => {
  it("show the verifier's failed turn separately from the later steps that completed", async () => {
    const backend = new FakeBackend();
    backend.recordNights.set("n-1", {
      night: {
        id: "n-1",
        kind: "night",
        at: at(3, 0),
        started_at: at(3, 0),
        ended_at: at(3, 10),
        seconds: 600,
        result: "failed",
        failed_at: at(3, 10),
        stages: { reflection: { result: "done" }, verifier: { result: "failed", reason: "時間切れ" }, curator: { result: "done" }, session: { result: "done" } },
      },
      turns: { verifier: turn("t-v", 3, 1, { triggers: [], trigger_count: 0, night: { id: "n-1", stage: "verifier" } }) },
    });
    start(backend, "#/record/nights/n-1");
    assert.ok(await screen.findByText("照合係が失敗"));
    assert.ok(screen.getByText("2. 照合係 ・ 失敗"));
    assert.ok(screen.getByText("4. 新しいセッション ・ 済み"));
    assert.ok(screen.getByRole("link", { name: /照合係/ }));
  });

  it("show a closed sub-agent's turns, a page more at a time", async () => {
    const backend = new FakeBackend();
    const sub = { id: "renovate-review", kind: "sub_agent", at: at(10, 30), agent: "renovate-review", purpose: "PR をまとめて確かめる", closed_at: at(10, 30), turns: 2, failed_turns: 0 } as const;
    const subTurn = (id: string, hour: number) => turn(id, hour, 0, { agent: "renovate-review", triggers: [], trigger_count: 0 });
    backend.recordSubAgents.set(
      "renovate-review",
      new Map([
        ["", { sub_agent: sub, turns: [subTurn("s-2", 10)], before: "p-2" }],
        ["p-2", { sub_agent: sub, turns: [subTurn("s-1", 9)] }],
      ]),
    );
    start(backend, "#/record/sub-agents/renovate-review");
    assert.ok(await screen.findByText("PR をまとめて確かめる"));
    assert.equal(screen.queryByText("9:00"), null);
    await press(screen.getByRole("button", { name: w.moreTurns(1) }));
    assert.ok(await screen.findByText("9:00"));
    assert.equal(screen.queryByRole("button", { name: /残り/ }), null);
  });
});

describe("a reply in the conversation", () => {
  it("links its time to the turn that sent it", async () => {
    const backend = new FakeBackend();
    const at = new Date().toISOString();
    backend.history = [{ kind: "agent", id: "r-1", at, text: "done", agent: "main", turn_id: "t-9" }];
    start(backend);
    const link = await within(await screen.findByRole("log")).findByRole("link", { name: w.seeTurn(timeOf(at)) });
    assert.equal(new URL((link as HTMLAnchorElement).href).hash, "#/record/turns/t-9");
  });

  // A reply whose turn is not known keeps its time as plain text.
  it("keeps its time as text when its turn is not known", async () => {
    const backend = new FakeBackend();
    const at = new Date().toISOString();
    backend.history = [{ kind: "agent", id: "r-1", at, text: "done", agent: "main" }];
    start(backend);
    const log = await screen.findByRole("log");
    assert.ok(await within(log).findByText(timeOf(at)));
    assert.equal(within(log).queryAllByRole("link").length, 0);
  });
});
