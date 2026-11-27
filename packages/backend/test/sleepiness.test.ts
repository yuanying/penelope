import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { openDatabase } from "../src/db.ts";
import { Sleepiness } from "../src/sleepiness.ts";
import { FakeClock, tempDir } from "./support.ts";

test("the status keeps the awake origin, current context and sleepiness peak across a restart", (t) => {
  const file = path.join(tempDir(t), "backend.sqlite");
  const clock = new FakeClock("2026-11-16T09:00:00Z");
  const first = openDatabase(file);
  const sleepiness = new Sleepiness(first, clock.now);
  sleepiness.turnEnded({ tokens: 8_000, context_window: 10_000 });
  const context = { tokens: 2_000, context_window: 10_000 };
  sleepiness.turnEnded(context);
  first.close();

  clock.advance(30);
  const second = openDatabase(file);
  t.after(() => second.close());
  assert.deepEqual(new Sleepiness(second, clock.now).status(), { sleepiness: 80, awake_seconds: 1_800, context });
});
