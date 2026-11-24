import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEnvelope } from "../src/envelope.ts";

const valid = {
  source: "slack",
  id: "C0123:1731574800.000100",
  occurred_at: "2026-11-14T09:00:00Z",
  summary: "#ops: a mention",
  stream: "ops",
  delivery: "now",
  payload: { type: "message" },
};

function refused(body: unknown): string {
  const parsed = parseEnvelope(body);
  assert.equal(parsed.ok, false, `expected ${JSON.stringify(body)} to be refused`);
  return parsed.ok ? "" : parsed.error;
}

describe("an envelope", () => {
  it("is taken with every field", () => {
    assert.deepEqual(parseEnvelope(valid), { ok: true, event: valid });
  });

  it("is taken without the optional stream and delivery", () => {
    const { stream: _s, delivery: _d, ...minimal } = valid;
    assert.deepEqual(parseEnvelope(minimal), { ok: true, event: minimal });
  });

  it("is taken with any JSON as the payload, null included", () => {
    assert.equal(parseEnvelope({ ...valid, payload: null }).ok, true);
    assert.equal(parseEnvelope({ ...valid, payload: [1, "a"] }).ok, true);
  });

  it("is refused when it is not an object", () => {
    assert.match(refused("x"), /object/);
    assert.match(refused([valid]), /object/);
    assert.match(refused(null), /object/);
  });

  it("is refused without a required field", () => {
    for (const field of ["source", "id", "occurred_at", "summary", "payload"]) {
      const { [field]: _gone, ...rest } = valid as Record<string, unknown>;
      assert.match(refused(rest), new RegExp(field));
    }
  });

  it("is refused when the source or the stream could leave its place under /sources", () => {
    for (const bad of ["../etc", "a/b", ".hidden", "Slack", "", "a b", "..", "."]) {
      assert.match(refused({ ...valid, source: bad }), /source/);
      assert.match(refused({ ...valid, stream: bad }), /stream/);
    }
  });

  it("takes lower-case letters, digits, dots, underscores and hyphens in the source and the stream", () => {
    assert.equal(parseEnvelope({ ...valid, source: "git-hub_2.x", stream: "c0123.a_b-c" }).ok, true);
  });

  it("refuses answer routes other than a single non-blank tool or command", () => {
    for (const answer_via of [null, [], {}, { tool: "" }, { command: " " }, { tool: 1 }, { tool: "reply", command: "post" }, { tool: "reply", to: "owner" }]) {
      assert.match(refused({ ...valid, answer_via }), /answer_via/);
    }
  });

  it("does not treat payload content as an answer route", () => {
    const event = { ...valid, payload: { answer_via: { tool: "reply" } } };
    assert.deepEqual(parseEnvelope(event), { ok: true, event });
  });

  it("is refused with a delivery other than now and batch", () => {
    assert.match(refused({ ...valid, delivery: "later" }), /delivery/);
  });

  it("is refused when occurred_at is not an RFC 3339 time", () => {
    assert.match(refused({ ...valid, occurred_at: "yesterday" }), /occurred_at/);
    assert.match(refused({ ...valid, occurred_at: "2026-11-14" }), /occurred_at/);
  });

  it("is refused with an empty id", () => {
    assert.match(refused({ ...valid, id: "" }), /id/);
  });
});
