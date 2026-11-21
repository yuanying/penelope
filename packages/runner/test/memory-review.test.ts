import assert from "node:assert/strict";
import { test } from "node:test";

import { planArchive, reviewTopics, weekDiary } from "../src/memory-review.ts";

test("the topic budget gives priority to never reviewed and least recently reviewed topics, skipping files that cannot fit", () => {
  const files = [
    { path: "recent.md", bytes: 4 },
    { path: "old.md", bytes: 4 },
    { path: "new.md", bytes: 4 },
    { path: "wide.md", bytes: 20 },
    { path: "always.md", bytes: 1 },
    { path: "INDEX.md", bytes: 1 },
    { path: "archive/2026-11.md", bytes: 1 },
    { path: "diary/2026-11-15.md", bytes: 1 },
  ];
  const lastReviews = new Map([["recent.md", "2026-11-12"], ["old.md", "2026-10-20"]]);
  assert.deepEqual(reviewTopics(files, lastReviews, 8), ["new.md", "old.md"]);
});

test("a topic larger than the entire budget gets a review to itself when its turn comes", () => {
  const files = [{ path: "large.md", bytes: 20 }, { path: "small.md", bytes: 1 }];
  assert.deepEqual(reviewTopics(files, new Map([["small.md", "2026-11-15"]]), 8), ["large.md"]);
});

test("the diary list spans the seven dates ending on the scheduled review date", () => {
  assert.deepEqual(weekDiary([
    "diary/2026-11-27.md", "diary/2026-11-29.md", "diary/2026-11-31.md", "diary/2026-12-04.md", "diary/2026-12-05.md",
  ], "2026-12-04"), ["diary/2026-11-29.md", "diary/2026-12-04.md"]);
});

test("a quarter is eligible from the third calendar month after its last month", () => {
  const paths = ["archive/2026-07.md", "archive/2026-09.md", "archive/2026-10.md", "archive/2026-00.md", "archive/notes.md", "diary/2026-09.md"];
  assert.deepEqual(planArchive(paths, "2026-11-30"), { current: "archive/2026-11.md", groups: [] });
  assert.deepEqual(planArchive(paths, "2026-12-01"), {
    current: "archive/2026-12.md",
    groups: [{ into: "archive/2026-Q3.md", from: ["archive/2026-07.md", "archive/2026-09.md"] }],
  });
});

test("from October of the following year old monthly and quarterly summaries go straight to the year", () => {
  const paths = ["archive/2025-12.md", "archive/2025-Q3.md", "archive/2025.md", "archive/2025-Q0.md"];
  assert.deepEqual(planArchive(paths, "2026-09-30").groups, [
    { into: "archive/2025-Q4.md", from: ["archive/2025-12.md"] },
  ]);
  assert.deepEqual(planArchive(paths, "2026-10-01").groups, [
    { into: "archive/2025.md", from: ["archive/2025-12.md", "archive/2025-Q3.md"] },
  ]);
});
