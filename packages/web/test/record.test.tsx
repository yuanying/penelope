// The activity record in the Web UI (docs/ui-api.md, "活動の記録";
// docs/design/README.md, 15): the count of the failures not seen, the list a
// day at a time, and each turn, night and closed sub-agent on its own page,
// reached by its address.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { RecordDayResponse, RecordNight, RecordRow, RecordTurn } from "@penelope/contract";

import { App } from "../src/ui/App.tsx";
import { timeOf, words } from "../src/ui/words.ts";
import { FakeBackend } from "./fake-backend.ts";

const w = words.record;
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
  render(<App fetch={backend.fetch} />);
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
  it("is on the phone's menu button", async () => {
    (window as unknown as HappyWindow).happyDOM.setViewport({ width: 390, height: 844 });
    const backend = new FakeBackend();
    backend.unseen = 4;
    start(backend);
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

  it("shows newly completed turns when the record is refreshed", async () => {
    const backend = new FakeBackend();
    backend.recordDays.set(backend.today, dayOf(backend.today, [failed]));
    start(backend, "#/record");
    await rowOf("[FIRING warning] HighMemoryUsage");
    backend.recordDays.set(backend.today, dayOf(backend.today, [turn("t-new", 15, 0, { triggers: [{ seq: 9, source: "slack", summary: "新しいメンション" }] }), failed]));
    await press(screen.findByRole("button", { name: "読み直す" }));
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
    });
    start(backend, "#/record");
    await follow(within(await rowOf("[FIRING warning] HighMemoryUsage")).getByRole("link"));
    assert.equal(window.location.hash, "#/record/turns/t-failed");
    assert.ok(await screen.findByRole("heading", { level: 1, name: "alertmanager ・ [FIRING warning] HighMemoryUsage" }));
    assert.ok(screen.getByText(/kubectl top pods/));
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
    backend.recordTurns.set("t-1", { turn: turn("t-1", 9, 0), flow: [], expired: true });
    start(backend, "#/record/turns/t-1");
    assert.ok(await screen.findByText(w.expired));
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

  it("distinguish unchanged memory and handoff from unavailable counts on the night row and its detail", async () => {
    const backend = new FakeBackend();
    const night: RecordNight = {
      id: "n-1", kind: "night", at: at(3, 0), started_at: at(3, 0), ended_at: at(3, 10), seconds: 600, result: "done",
      stages: {
        reflection: { result: "done", memory_change: { files: 0, added: 0, removed: 0, handoff_changed: false } },
        verifier: { result: "done" },
        curator: { result: "done", memory_change: { files: 2, added: 18, removed: 5 } },
        session: { result: "done" },
      },
    };
    backend.recordDays.set(backend.today, dayOf(backend.today, [night]));
    backend.recordNights.set(night.id, { night, turns: {} });
    start(backend, "#/record");
    const link = await screen.findByRole("link", { name: /夜の切り替え/ });
    assert.ok(within(link).getByText("記憶の変更なし ・ 引き継ぎ未更新"));
    assert.ok(within(link).getByText("記憶の変更は不明"));
    assert.ok(within(link).getByText("記憶 2 ファイル +18/−5 行"));
    await follow(link);
    const detail = within(await screen.findByRole("article"));
    assert.ok(await detail.findByText("1. 振り返り ・ 済み"));
    assert.ok(detail.getByText("記憶の変更なし ・ 引き継ぎ未更新"));
    assert.ok(detail.getByText("記憶の変更は不明"));
    assert.ok(detail.getByText("記憶 2 ファイル +18/−5 行"));
  });

  it("shows why a completed night needs attention on the row and in its detail", async () => {
    const backend = new FakeBackend();
    const night: RecordNight = {
      id: "n-warning", kind: "night", at: at(3, 0), started_at: at(3, 0), ended_at: at(3, 10), seconds: 600, result: "done",
      stages: {
        reflection: { result: "done" }, session: { result: "done" },
        verifier: { result: "done", dropped_records: 2 },
        curator: { result: "done", always_read_over_target: { total_bytes: 18240, target_bytes: 16384 } },
      },
    };
    backend.recordDays.set(backend.today, dayOf(backend.today, [night]));
    backend.recordNights.set(night.id, { night, turns: {} });
    start(backend, "#/record");
    const link = await screen.findByRole("link", { name: /夜の切り替え/ });
    const warning = /毎回読む層が目安を超過（18240 \/ 16384 バイト）.*照合対象から外れた未照合の記録 2 件/;
    assert.ok(within(link).getByText(warning));
    await follow(link);
    assert.ok(await within(await screen.findByRole("article")).findByText(warning));
  });

  it("shows each weekly review turn's result, reason and memory change", async () => {
    const backend = new FakeBackend();
    const night: RecordNight = {
      id: "n-review", kind: "night", at: at(3, 0), started_at: at(3, 0), ended_at: at(3, 10), seconds: 600, result: "failed",
      stages: {
        reflection: { result: "done" }, verifier: { result: "done" }, session: { result: "done" },
        curator: { result: "failed", review: {
          content: { result: "failed", reason: "モデルが停止", turn_id: "t-content", memory_change: { files: 1, added: 4, removed: 0 } },
          structure: { result: "done", memory_change: { files: 2, added: 0, removed: 3 } },
        } },
      },
    };
    backend.recordDays.set(backend.today, dayOf(backend.today, [night]));
    backend.recordNights.set(night.id, { night, turns: {
      content: turn("t-content", 3, 1, { triggers: [], trigger_count: 0, night: { id: night.id, stage: "curator" } }),
    } });
    start(backend, "#/record");
    await follow(await screen.findByRole("link", { name: /夜の切り替え（棚卸し）/ }));
    const content = within((await screen.findByText("中身 ・ 失敗")).closest("li")!);
    assert.ok(content.getByText("モデルが停止"));
    assert.ok(content.getByText("記憶 1 ファイル +4/−0 行"));
    assert.equal(content.getByRole("link").getAttribute("href"), "#/record/turns/t-content");
    const structure = within(screen.getByText("構成 ・ 済み").closest("li")!);
    assert.ok(structure.getByText("記憶 2 ファイル +0/−3 行"));
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
