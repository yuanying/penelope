import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { HouseConversationSyncResult, HouseEvent, HouseView, RecordDayResponse, RecordTurnResponse } from "@penelope/contract";

import { E2E_PNG } from "../outside/model.ts";
import { type Browser, eventually, exec, fromOutside, outside, RUN_DIR, where } from "./support.ts";

export async function houseRoundTrip(browser: Browser): Promise<void> {
  const token = readFileSync(join(RUN_DIR, "stranger-token"), "utf8").trim();
  const call = (method: string, path: string, body?: unknown) => fromOutside(method, `http://127.0.0.1:8080/v1/agent/${path}`, {
    authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }),
  }, body === undefined ? "" : JSON.stringify(body));

  const entered = call("POST", "rooms/living/enter");
  assert.equal(entered.status, 200, entered.text);
  assert.match(exec("sandbox", "house enter living").stdout, /Entered living/);
  await eventually("the house sees Penelope awake in the room", () => {
    const answer = call("GET", "house");
    assert.equal(answer.status, 200, answer.text);
    const view = JSON.parse(answer.text) as HouseView;
    return view.rooms[0]?.occupants.find((actor) => actor.id === "penelope" && actor.status?.sleep.state === "awake");
  });

  const sent = call("POST", "reply", {
    text: "E2E-HOUSE-IMAGE", to: ["penelope"], images: [{ name: "figure.png", data: E2E_PNG }],
  });
  assert.equal(sent.status, 200, sent.text);

  const reply = await eventually("Penelope's image reply at the house", () => {
    const answer = call("POST", "sync", { protocol: 2, status: { mood: null, sleepiness: 0, sleep: { state: "awake" } } });
    assert.equal(answer.status, 200, answer.text);
    const { pending } = JSON.parse(answer.text) as HouseConversationSyncResult;
    return pending.find(({ event }) => event.kind === "speech" && event.text === "E2E-HOUSE-REPLY");
  });
  const speech = reply.event as Extract<HouseEvent, { kind: "speech" }>;
  assert.deepEqual([speech.actor.id, speech.room.id, speech.expression, speech.to], ["penelope", "living", "happy", ["neighbor"]]);
  const [image] = speech.images ?? [];
  assert.ok(image);
  const bytes = exec("outside", `node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const token = readFileSync("/run/secrets/e2e/stranger-token", "utf8").trim();
    const response = await fetch(${JSON.stringify(`http://127.0.0.1:8080/v1/agent/images/${encodeURIComponent(image.id)}`)}, {
      headers: { authorization: "Bearer " + token }
    });
    if (!response.ok) throw new Error("house image returned HTTP " + response.status);
    process.stdout.write(Buffer.from(await response.arrayBuffer()).toString("base64"));
  '`).stdout;
  assert.equal(bytes, E2E_PNG);

  const modelInput = (await outside.modelCalls()).map(where).find(({ input }) => input.includes("E2E-HOUSE-IMAGE"))?.input;
  assert.ok(modelInput);
  assert.match(modelInput, /"answer_via":\{"tool":"reply"\}/);
  assert.match(modelInput, /"path":"\/sources\/house\/files\//);

  const auth = (await outside.seen()).filter(({ host, method, path }) =>
    host === "house.example.com" && method === "POST" && path === "/v1/agent/reply");
  assert.ok(auth.some(({ credential }) => credential === "real"), "the house received the service account token");
  assert.ok(!auth.some(({ credential }) => credential === "surrogate"), "the surrogate did not leave the Sentinel");

  await eventually("the house speech ID on its originating turn", () => {
    const { body } = browser.json<RecordDayResponse>("/api/record?kind=turn");
    for (const row of body.rows) {
      if (row.kind !== "turn" || !row.triggers.some(({ source }) => source === "house")) continue;
      const detail = browser.json<RecordTurnResponse>(`/api/record/turns/${encodeURIComponent(row.id)}`);
      if (detail.body.house_reply_ids?.includes(speech.id)) return detail.body.turn.result === "done" ? detail : undefined;
    }
  });
}
