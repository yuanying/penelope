import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApi } from "../src/model/api.ts";
import { myRoom, Session } from "../src/model/session.ts";
import { BATH, FakeHouse, FERN, IVY, LIVING, speech } from "./fake-house.ts";

/** Lets what was started settle: the fake answers at once. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function start(house: FakeHouse, wait: (ms: number) => Promise<void> = async () => {}) {
  const session = new Session({ api: createApi(house.fetch), open: house.open, wait });
  session.start();
  return session;
}

const texts = (session: Session, room: string) => session.getSnapshot().logs.get(room)!.events.map((event) => (event.kind === "speech" ? event.text : event.kind));
const livingLog = (session: Session) => texts(session, LIVING.id);
/** A wait that is over when the test says so. */
function waiting() {
  let over!: () => void;
  const wait = () => new Promise<void>((resolve) => (over = resolve));
  return { wait, over: () => over() };
}

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

  // What the stream brings after a reading of the record failed is newer than what was missed: it must not pass for read.
  it("still reads what was missed when the reading of the record failed and the line dropped again", async () => {
    const house = new FakeHouse();
    const session = start(house, () => new Promise(() => {}));
    house.ready();
    await settle();
    house.happen(speech(LIVING, IVY, "one"));

    house.drop();
    house.happen(speech(LIVING, IVY, "two"), { heard: false });
    house.failures.history = 1;
    house.ready();
    await settle();
    house.happen(speech(LIVING, IVY, "three"));
    house.drop();
    house.ready();
    await settle();

    assert.deepEqual(livingLog(session), ["one", "two", "three"]);
  });

  it("reads the record again by itself after a reading of it failed", async () => {
    const house = new FakeHouse();
    house.happen(speech(LIVING, IVY, "one"), { heard: false });
    house.failures.history = 1;
    const session = start(house);
    house.ready();
    await settle();

    assert.deepEqual(livingLog(session), ["one"]);
  });

  // The newest page of a record that was never read may not reach back to what the stream brought first.
  it("puts what the stream brought before the first reading succeeded where the record has it", async () => {
    const house = new FakeHouse();
    house.failures.history = 1;
    const session = start(house, () => new Promise(() => {}));
    house.ready();
    await settle();
    for (let line = 1; line <= 51; line += 1) house.happen(speech(LIVING, IVY, String(line)));

    house.drop();
    house.ready();
    await settle();

    assert.deepEqual(livingLog(session), Array.from({ length: 51 }, (_, index) => String(index + 1)));
  });

  // The record's first page is asked for while the stream is already bringing events: which comes first is not the house's to say.
  it("puts what the stream brought while the first reading was on its way where the record has it", async () => {
    const house = new FakeHouse();
    const through = house.stall("history");
    const session = start(house);
    house.ready();
    await settle();
    for (let line = 1; line <= 51; line += 1) house.happen(speech(LIVING, IVY, String(line)));

    through();
    await settle();

    assert.deepEqual(livingLog(session), Array.from({ length: 51 }, (_, index) => String(index + 1)));
  });

  it("puts what the stream brought while a second try at the first reading was on its way where the record has it", async () => {
    const house = new FakeHouse();
    house.failures.history = 1;
    const session = start(house);
    house.ready();
    const through = house.stall("history");
    await settle();
    for (let line = 1; line <= 51; line += 1) house.happen(speech(LIVING, IVY, String(line)));

    through();
    await settle();

    assert.deepEqual(livingLog(session), Array.from({ length: 51 }, (_, index) => String(index + 1)));
  });

  it("leaves no gap under the newest page when the stream brought something older before the record was ever read", async () => {
    const house = new FakeHouse();
    house.pageSize = 2;
    house.failures.history = 1;
    const session = start(house, () => new Promise(() => {}));
    house.ready();
    await settle();
    house.happen(speech(LIVING, IVY, "one"));

    house.drop();
    for (const text of ["two", "three", "four"]) house.happen(speech(LIVING, IVY, text), { heard: false });
    house.ready();
    await settle();

    assert.deepEqual(livingLog(session), ["one", "two", "three", "four"]);
  });

  it("puts an event the stream brings after a newer page of the record was read where the record has it", async () => {
    const house = new FakeHouse();
    house.pageSize = 2;
    const [one, two, three] = ["one", "two", "three"].map((text) => speech(LIVING, IVY, text));
    for (const event of [one!, two!, three!]) house.happen(event, { heard: false });
    const session = start(house);
    house.ready();
    await settle();

    house.tell(one!);

    assert.deepEqual(livingLog(session), ["one", "two", "three"]);
  });

  // What one unbroken stream brought has no gap in it: a new connection has nothing to read under it.
  it("reads no further back than what the stream brought without a break", async () => {
    const house = new FakeHouse();
    house.happen(speech(LIVING, IVY, "before"), { heard: false });
    const session = start(house, () => new Promise(() => {}));
    house.ready();
    await settle();
    for (let line = 1; line <= 52; line += 1) house.happen(speech(LIVING, IVY, String(line)));

    house.drop();
    house.happen(speech(LIVING, IVY, "missed"), { heard: false });
    house.pagesAsked.length = 0;
    house.olderPagesFail = true;
    house.ready();
    await settle();

    assert.equal(livingLog(session).at(-1), "missed");
    assert.deepEqual(house.pagesAsked, [undefined]);
  });

  it("shows the pages of the record it read while an older one cannot be read", async () => {
    const house = new FakeHouse();
    house.happen(speech(LIVING, IVY, "before"), { heard: false });
    const session = start(house, () => new Promise(() => {}));
    house.ready();
    await settle();

    house.drop();
    for (let line = 1; line <= 60; line += 1) house.happen(speech(LIVING, IVY, String(line)), { heard: false });
    house.olderPagesFail = true;
    house.ready();
    await settle();

    assert.equal(livingLog(session).at(-1), "60");
  });

  it("fills a gap in a room that was hidden while the stream reconnected", async () => {
    const house = new FakeHouse();
    house.pageSize = 2;
    house.happen(speech(BATH, FERN, "before"), { heard: false });
    const session = start(house);
    house.ready();
    session.show(BATH.id);
    await settle();
    session.show(undefined);
    house.drop();
    for (const text of ["one", "two", "three"]) house.happen(speech(BATH, FERN, text), { heard: false });
    house.ready();
    house.happen(speech(BATH, FERN, "after"));
    session.show(BATH.id);
    await settle();

    assert.deepEqual(texts(session, BATH.id), ["before", "one", "two", "three", "after"]);
  });

  it("drops a late page from before reconnecting when the room is looked into again", async () => {
    const house = new FakeHouse();
    house.happen(speech(BATH, FERN, "1"), { heard: false });
    const session = start(house);
    house.ready();
    await settle();
    const late = house.hold("history");
    session.show(BATH.id);
    await settle();

    house.drop();
    session.show(undefined);
    for (let line = 2; line <= 53; line += 1) house.happen(speech(BATH, FERN, String(line)), { heard: false });
    session.show(BATH.id);
    house.ready();
    await settle();
    late.give();
    await settle();

    assert.deepEqual(texts(session, BATH.id), Array.from({ length: 50 }, (_, index) => String(index + 4)));
    assert.notEqual(session.getSnapshot().logs.get(BATH.id)!.before, undefined);
  });

  // The tab's place is the house's, and the stream is how the house tells it: an answer on the way is older than that.
  it("keeps the room the stream told of when the answer to an earlier entering comes late", async () => {
    const house = new FakeHouse();
    house.house = house.withLeeIn(undefined);
    const session = start(house);
    house.ready();
    await settle();
    const late = house.hold("enter");
    const entering = session.enter(LIVING.id);
    await settle();

    house.floor(house.withLeeIn(BATH.id));
    late.give();
    await entering;

    assert.equal(myRoom(session.getSnapshot()), BATH.id);
  });

  // The stream tells of floors in their order, but the answer to entering comes on a way of its own:
  // a floor that came before it may still be the one from before the entering.
  it("has entered once the floor shows the room, when an older floor came before the answer", async () => {
    const house = new FakeHouse();
    house.house = house.withLeeIn(undefined);
    const session = start(house, () => new Promise(() => {}));
    house.ready();
    await settle();
    const olderFloor = house.house;
    const answer = house.hold("enter");
    const entering = session.enter(LIVING.id);
    await settle();

    house.floor(olderFloor);
    answer.give();
    await entering;
    assert.equal(myRoom(session.getSnapshot()), undefined);

    house.floor(house.withLeeIn(LIVING.id));

    assert.equal(myRoom(session.getSnapshot()), LIVING.id);
  });

  // docs/house.md: a 5xx may come from in front of the house, after the house recorded the speech.
  it("does not take a speech for unsaid when the answer is an error of the server", async () => {
    const house = new FakeHouse();
    const session = start(house);
    house.ready();
    await settle();
    house.failures.say = 1;

    assert.equal(await session.say(LIVING.id, "did this arrive?", []), "unknown");
  });

  it("asks the house to say nothing in a room the person is no longer in", async () => {
    const house = new FakeHouse();
    const session = start(house);
    house.ready();
    await settle();
    house.floor(house.withLeeIn(BATH.id));

    assert.equal(await session.say(LIVING.id, "only for the living room", []), "refused");
    assert.deepEqual(house.writes, []);
  });

  // docs/house.md, 人のログイン: the session is over when the house says so, not when the button was pressed.
  it("stays signed in and says so when the house did not end the session", async () => {
    const house = new FakeHouse();
    house.failures.logout = 1;
    const session = start(house);
    house.ready();
    await settle();

    await session.logout();

    assert.equal(session.getSnapshot().signedIn, true);
    assert.deepEqual(session.getSnapshot().notice, { kind: "logout-unconfirmed" });
  });

  it("is signed out when the answer to the logout was lost but the house ended the session", async () => {
    const house = new FakeHouse();
    const session = start(house);
    house.ready();
    await settle();
    const answer = house.hold("logout");
    const leaving = session.logout();
    answer.lose();
    await leaving;

    assert.equal(session.getSnapshot().signedIn, false);
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

  // docs/house.md, 接続と居場所: no way of asking for the stream again passes by the question about the session.
  it("opens no stream on being told to connect again before the house answered about the session", async () => {
    const house = new FakeHouse();
    house.streamStatus = 503;
    const session = start(house, () => new Promise(() => {}));
    await settle();
    assert.equal(session.getSnapshot().line.kind, "refused");

    house.streamStatus = 200;
    const answer = house.hold("house");
    session.retry();
    await settle();
    assert.equal(house.sources.length, 1);

    answer.give();
    await settle();
    assert.equal(house.sources.length, 2);
  });

  it("asks about the session again, and opens no stream, while the house cannot answer about it", async () => {
    const house = new FakeHouse();
    house.streamStatus = 503;
    house.failures.house = 1;
    const pause = waiting();
    const session = start(house, pause.wait);
    await settle();
    assert.equal(house.sources.length, 1);
    assert.equal(session.getSnapshot().signedIn, undefined);

    house.streamStatus = 200;
    pause.over();
    await settle();
    assert.equal(session.getSnapshot().signedIn, true);
    assert.equal(house.sources.length, 1);
  });

  it("opens no stream for a late refusal of an old connection while the house is asked about the session", async () => {
    const house = new FakeHouse();
    const session = start(house, () => new Promise(() => {}));
    house.ready();
    await settle();
    house.refusals.say = "connection-required";
    const late = house.hold("say");
    const saying = session.say(LIVING.id, "hello", []);
    await settle();

    house.hold("house");
    house.refuseStream();
    await settle();
    late.give();
    await saying;
    await settle();

    assert.equal(house.sources.length, 1);
  });
});
