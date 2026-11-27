import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dayIn } from "../src/time.ts";

const at = (iso: string) => Date.parse(iso);

describe("the day of a time", () => {
  it("is the date in the time zone", () => {
    assert.equal(dayIn(at("2026-11-14T15:30:00Z"), "Asia/Tokyo"), "2026-11-15");
    assert.equal(dayIn(at("2026-11-14T15:30:00Z"), "UTC"), "2026-11-14");
  });
});
