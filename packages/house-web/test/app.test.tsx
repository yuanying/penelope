import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { App } from "../src/ui/App.tsx";
import { asleep, awake, BATH, FakeHouse, FERN, IVY, LEE, LIVING, speech } from "./fake-house.ts";

/** Opens the screen on the house, signed in and connected. */
async function open(house = new FakeHouse()) {
  render(<App fetch={house.fetch} open={house.open} wait={async () => {}} />);
  await act(async () => {
    house.ready();
  });
  return house;
}

/** Writes in the field and sends it, as the person would with the keyboard. */
async function say(text: string) {
  const field = screen.getByLabelText("Livingで話す");
  await act(async () => {
    field.textContent = text;
    fireEvent.input(field);
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
  });
}

const myRoom = () => screen.getByRole("region", { name: "自分のいる部屋" });

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("the house's screen", () => {
  // ADR-0075, 8: looking in is not entering. No one is told, and no one's turn starts.
  it("shows a room's record when it is looked into, and enters nothing", async () => {
    const house = new FakeHouse();
    house.happen(speech(BATH, FERN, "warm in here"), { heard: false });
    await open(house);

    fireEvent.click(screen.getByRole("button", { name: "Bathを覗く" }));
    await act(async () => {
      house.ready();
    });

    const peeked = screen.getByRole("region", { name: "覗いている部屋" });
    await within(peeked).findByText("warm in here");
    assert.match(house.sources.at(-1)!.url, /\?peek=bath$/);
    assert.deepEqual(house.writes, []);
  });

  // ADR-0075, 1: a full room is not entered; the screen does not offer what the house would refuse.
  it("offers no way into a room that is full", async () => {
    await open();
    assert.equal(screen.queryByRole("button", { name: "Bathに入る" }), null);
    assert.ok(screen.getByText("満員で入れません"));
  });

  it("says so when a room filled up before the person got in", async () => {
    const house = new FakeHouse();
    const [living, bath] = house.house.rooms;
    house.house = { ...house.house, rooms: [{ ...living!, occupants: [awake(IVY)] }, bath!], away: [LEE] };
    house.filled.add("living");
    await open(house);

    fireEvent.click(screen.getByRole("button", { name: "Livingに入る" }));

    await screen.findByText("Livingは満員で入れませんでした。");
  });

  // ADR-0075, 5: a sleeper is never reached, also not after waking, and the speaker is told so.
  it("says under a speech whom it did not reach", async () => {
    const house = new FakeHouse();
    house.notDelivered = [IVY];
    await open(house);

    await say("anyone awake?");

    await within(myRoom()).findByText("Ivy は寝ているので届いていません。起きた後にも届きません。");
  });

  it("sends a speech with the connection of the stream that is open", async () => {
    const house = new FakeHouse();
    render(<App fetch={house.fetch} open={house.open} wait={async () => {}} />);
    let connection!: string;
    await act(async () => {
      house.ready();
      house.drop();
      connection = house.ready();
    });

    await say("hello");

    assert.deepEqual(house.said, [{ room: "living", speech: { text: "hello" }, connection }]);
  });

  // docs/house.md, 話す: a speech with no answer may be recorded, so it is never sent again by itself.
  it("keeps what was written when no answer came, and sends it only once", async () => {
    const house = new FakeHouse();
    house.loseSayAnswers = true;
    await open(house);

    await say("did you hear?");

    await within(myRoom()).findByText("送れたか確かめられませんでした。会話に出ていなければ、もう一度送ってください。");
    assert.equal(screen.getByLabelText("Livingで話す").textContent, "did you hear?");
    assert.equal(house.said.length, 1);
  });

  // ADR-0075, 2: nothing is said while the line is down, and nothing is kept to send later.
  it("lets nothing be written while the line is down, and says why", async () => {
    const house = await open();

    await act(async () => {
      house.drop();
    });

    assert.equal(screen.getByLabelText("Livingで話す").getAttribute("contenteditable"), "false");
    assert.ok(within(myRoom()).getByText("接続が切れました。つなぎ直しています。"));
  });

  it("has no field to speak in for one who is in no room", async () => {
    const house = new FakeHouse();
    const [living, bath] = house.house.rooms;
    house.house = { ...house.house, rooms: [{ ...living!, occupants: [awake(IVY)] }, bath!], away: [LEE] };
    await open(house);

    assert.ok(within(myRoom()).getByText("いまはどの部屋にもいません"));
    assert.equal(screen.queryByLabelText(/で話す$/), null);
  });

  // The decision of 2026-11-27: there is no picture of a sleeper; the same picture is marked, and words say so.
  it("draws a sleeping resident with their own picture and says until when they sleep", async () => {
    const house = new FakeHouse();
    const [living, bath] = house.house.rooms;
    const sleeper = { ...asleep(IVY, "2026-11-28T07:30:00+09:00"), avatar_url: "https://ivy.example.com/neutral.png" };
    house.house = { ...house.house, rooms: [{ ...living!, occupants: [sleeper, { ...LEE, connected: true }] }, bath!] };
    await open(house);

    const tile = screen.getByRole("article", { name: "Living" });
    assert.equal(tile.querySelector("img")?.getAttribute("src"), "https://ivy.example.com/neutral.png");
    assert.ok(within(tile).getByText(/^寝ている・\d{1,2}:30 に起きる$/));
  });

  // docs/house.md, 接続と居場所: when the room to come back to is full, the person is in none and is told.
  it("says so when the room to come back to was full", async () => {
    const house = new FakeHouse();
    render(<App fetch={house.fetch} open={house.open} wait={async () => {}} />);
    await act(async () => {
      house.ready({ return_failed: "bath" });
    });

    await waitFor(() => assert.ok(screen.getByText("Bathは満員なので、どの部屋にもいません。空いたら、間取りから入れます。")));
  });
});
