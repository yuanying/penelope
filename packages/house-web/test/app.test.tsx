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

    const peeked = screen.getByRole("region", { name: "覗いている部屋" });
    await within(peeked).findByText("warm in here");
    assert.deepEqual(house.sources.map(({ url }) => url), ["/api/stream"]);
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
    house.house = house.withLeeIn(undefined);
    house.filled.add("living");
    await open(house);

    fireEvent.click(screen.getByRole("button", { name: "Livingに入る" }));

    const chosen = window.location.hash;
    await screen.findByText("Livingは満員で入れませんでした。");
    assert.equal(window.location.hash, chosen);

    fireEvent.click(screen.getByRole("button", { name: "間取りに戻る" }));

    assert.equal(window.location.hash, "#/");
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

  // docs/house.md, 話す: a speech with no answer may be recorded, so it is never sent again by itself,
  // and never as part of what is written next.
  it("keeps a speech with no answer apart from what is written next, and sends it only once", async () => {
    const house = new FakeHouse();
    await open(house);
    const answer = house.hold("say");
    await say("did you hear?");

    const field = screen.getByLabelText("Livingで話す");
    await act(async () => {
      field.textContent = "and another thing";
      fireEvent.input(field);
    });
    await act(async () => {
      answer.lose();
    });

    const unsent = await within(myRoom()).findByRole("group", { name: "送れたか確かめられなかった発言" });
    assert.ok(within(unsent).getByText("did you hear?"));
    assert.equal(field.textContent, "and another thing");
    assert.equal(house.said.length, 1);
  });

  it("opens a speech with no answer only when it is asked to", async () => {
    const house = new FakeHouse();
    await open(house);
    for (const text of ["first", "second"]) {
      const answer = house.hold("say");
      await say(text);
      await act(async () => {
        answer.lose();
      });
    }
    const [first] = await within(myRoom()).findAllByRole("group", { name: "送れたか確かめられなかった発言" });

    fireEvent.click(within(first!).getByRole("button", { name: "全文を開く" }));
    fireEvent.click(within(first!).getByRole("button", { name: "捨てる" }));

    const second = within(myRoom()).getByRole("group", { name: "送れたか確かめられなかった発言" });
    assert.ok(within(second).getByText("second"));
    assert.ok(within(second).getByRole("button", { name: "全文を開く" }));
  });

  // Entering is asked for and comes true later. What the person chose to look at since is theirs.
  it("leaves a room that was looked into after entering another was asked for on the screen", async () => {
    const house = new FakeHouse();
    house.house = house.withLeeIn(undefined);
    await open(house);
    const answer = house.hold("enter");
    fireEvent.click(screen.getByRole("button", { name: "Livingに入る" }));
    fireEvent.click(screen.getByRole("button", { name: "Bathを覗く" }));

    await act(async () => {
      house.floor(house.withLeeIn(LIVING.id));
      answer.give();
    });

    assert.ok(screen.getByRole("region", { name: "覗いている部屋" }));
    assert.equal(window.location.hash, "#/peek/bath");
  });

  it("stays where the browser's back button took the person while entering a room was on its way", async () => {
    const house = new FakeHouse();
    house.house = house.withLeeIn(undefined);
    await open(house);
    fireEvent.click(screen.getByRole("button", { name: "Livingを覗く" }));
    const answer = house.hold("enter");
    fireEvent.click(await screen.findByRole("button", { name: "ここに入る" }));

    await act(async () => {
      window.history.replaceState(null, "", "#/");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await act(async () => {
      answer.give();
    });
    await screen.findByLabelText("Livingで話す");

    assert.equal(window.location.hash, "#/");
  });

  it("lets a PC switch from a selected read-only conversation to the current room", async () => {
    window.location.hash = "#/talk/bath";
    await open();
    const reading = screen.getByRole("region", { name: "読み取り専用の会話" });
    assert.ok(within(reading).getByRole("heading", { name: "Bath" }));

    const current = screen.getByRole("article", { name: "Living" });
    fireEvent.click(within(current).getByRole("button", { name: "会話を開く" }));

    assert.ok(await screen.findByLabelText("Livingで話す"));
  });

  // The decision of the review of 2026-11-27: what is written is the room's it was written in.
  it("leaves what was written in a room there when the person moves to another", async () => {
    const house = await open();
    const field = screen.getByLabelText("Livingで話す");
    await act(async () => {
      field.textContent = "only for the living room";
      fireEvent.input(field);
    });

    await act(async () => {
      house.floor(house.withLeeIn("bath"));
    });
    assert.equal((await screen.findByLabelText("Bathで話す")).textContent, "");

    await act(async () => {
      house.floor(house.withLeeIn("living"));
    });
    assert.equal((await screen.findByLabelText("Livingで話す")).textContent, "only for the living room");
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
    house.house = house.withLeeIn(undefined);
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
