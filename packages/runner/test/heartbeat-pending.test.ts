import assert from "node:assert/strict";
import { test } from "node:test";

import type { HeartbeatPending } from "@penelope/contract";

import { withHeartbeatPending } from "../src/heartbeat-pending.ts";
import { formatEvents } from "../src/turn-input.ts";
import { heartbeat } from "./world.ts";

const at = (minute: number) => `2026-11-14T09:0${minute}:00.000Z`;

test("the heartbeat shows the oldest jobs and counts those that do not fit", () => {
  const jobs = [3, 6, 2, 7, 1, 5, 4].map((minute) => ({
    id: `job-${minute}`, started_at: at(minute), command: "echo test", cwd: "/work", timeout_seconds: 60, output: "/work/output.log",
  }));
  const [line] = withHeartbeatPending([heartbeat(1)], { list: () => jobs }, { heartbeatState: () => [] }, assert.fail);
  assert.deepEqual(line?.pending?.jobs, {
    items: [1, 2, 3, 4, 5].map((minute) => ({ job: `job-${minute}`, started_at: at(minute), command: "echo test" })),
    omitted: 2,
  });
});

test("the wake notice in the turn shows background jobs that are still running", () => {
  const input = formatEvents(withHeartbeatPending(
    [{ ...heartbeat(1), source: "wake" }],
    { list: () => [{ id: "job-1", started_at: at(1), command: "make test", cwd: "/work", timeout_seconds: 60, output: "/work/out" }] },
    { heartbeatState: () => [] },
    assert.fail,
  ));
  const line = JSON.parse(input.split("\n")[1]!);
  assert.deepEqual(line.pending.jobs.items, [{ job: "job-1", started_at: at(1), command: "make test" }]);
});

test("when one runner category cannot be collected, the others still reach the heartbeat", () => {
  const pending: HeartbeatPending = {
    a2a_tasks: { items: [{ sender: "Example", state: "working", task_id: "example-task", since: at(1), seq: 10, summary: "Review" }], omitted: 0 },
    failures: { items: [{ kind: "turn", at: at(2), reason: "Model failed" }], omitted: 0 },
  };
  const subagent = { name: "review", purpose: "Review", state: "waiting" as const, since: at(3) };
  const [line] = withHeartbeatPending(
    [{ ...heartbeat(1), pending }],
    { list: () => { throw new Error("jobs unavailable"); } },
    { heartbeatState: () => [subagent] },
    () => {},
  );
  assert.deepEqual(line?.pending, { ...pending, subagents: { items: [subagent], omitted: 0 } });
});
