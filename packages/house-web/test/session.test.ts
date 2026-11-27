import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApi } from "../src/model/api.ts";
import { myRoom, Session } from "../src/model/session.ts";
import { FakeHouse, IVY, LIVING, speech } from "./fake-house.ts";

/** Lets what was started settle: the fake answers at once. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function start(house: FakeHouse, wait: (ms: number) => Promise<void> = async () => {}) {
  const session = new Session({ api: createApi(house.fetch), open: house.open, wait });
  session.start();
  return session;
}

const livingLog = (session: Session) => session.getSnapshot().logs.get(LIVING.id)!.events.map((event) => (event.kind === "speech" ? event.text : event.kind));

describe("the line to the house", () => {
  // docs/house.md, 接続と居場所: the stream has no replay, so each `ready` reads the record back to the newest event held.
  it("reads what was said while it was down, in order and once", async () => {
    const house = new FakeHouse();
    house.pageSize = 2;
    house.happen(speech(LIVING, IVY, "one"), { heard: false });
    const session = start(house);
    house.ready();
    await settle();
    house.happen(speech(LIVING, IVY, "two"));

    house.drop();
    for (const text of ["three", "four", "five"]) house.happen(speech(LIVING, IVY, text), { heard: false });
    house.ready();
    // Heard on the new line while the record is still being read.
    house.happen(speech(LIVING, IVY, "six"));
    await settle();

    assert.deepEqual(livingLog(session), ["one", "two", "three", "four", "five", "six"]);
  });

  it("is not opened again when the house refuses it and the session is gone", async () => {
    const house = new FakeHouse();
    house.signedIn = false;
    house.streamStatus = 401;
    const session = start(house);
    await settle();

    assert.equal(session.getSnapshot().signedIn, false);
    assert.equal(house.sources.length, 1);
  });

  it("is opened again after a wait when the house refuses it and the session is good", async () => {
    const house = new FakeHouse();
    house.streamStatus = 503;
    let waited!: () => void;
    const session = start(house, () => new Promise<void>((resolve) => (waited = resolve)));
    await settle();
    assert.equal(session.getSnapshot().line.kind, "refused");
    // The floor is shown from what the house answered while it was asked about the session.
    assert.equal(myRoom(session.getSnapshot()), LIVING.id);

    house.streamStatus = 200;
    waited();
    await settle();
    house.ready();
    assert.equal(session.getSnapshot().line.kind, "open");
  });
});
