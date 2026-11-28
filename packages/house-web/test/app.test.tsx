import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { HouseDirectAvailability } from "@penelope/contract";

import { App } from "../src/ui/App.tsx";
import { asleep, awake, BATH, directSpeech, FakeHouse, FERN, IVY, LEE, LIVING, speech } from "./fake-house.ts";

/** Opens the screen on the house, signed in and connected. */
async function open(house = new FakeHouse()) {
  render(<App fetch={house.fetch} open={house.open} wait={async () => {}} />);
  await act(async () => {
    house.ready();
  });
  return house;
}

/** Writes in the field and sends it, as the person would with the keyboard. */
async function say(text: string, label = "Livingで話す") {
  const field = screen.getByLabelText(label);
  await act(async () => {
    field.textContent = text;
    fireEvent.input(field);
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
  });
}

const myRoom = () => screen.getByRole("region", { name: "自分のいる部屋" });
const readOnlyRoom = () => screen.getByRole("region", { name: "読み取り専用の会話" });
const viewport = (width: number) => {
  (window as unknown as { happyDOM: { setViewport: (size: { width: number; height: number }) => void } }).happyDOM.setViewport({ width, height: 844 });
};

afterEach(() => {
  cleanup();
  viewport(1024);
  window.location.hash = "";
});

function withAwayIvy(house: FakeHouse, availability: Partial<Omit<HouseDirectAvailability, "agent_id">> = {}) {
  return {
    ...house.house,
    rooms: house.house.rooms.map((room) => ({ ...room, occupants: room.occupants.filter(({ id }) => id !== IVY.id) })),
    away: [IVY],
    direct: [{ agent_id: IVY.id, send: "ready" as const, sleeping: false, connected: true, ...availability }],
  };
}

const ivyDirect = () => screen.getByRole("link", { name: "Ivy との1対1を開く" });

describe("the house's screen", () => {
  it("opens an away resident's direct conversation without entering or reopening the stream", async () => {
    const house = new FakeHouse();
    house.house = withAwayIvy(house);
    house.direct(directSpeech(IVY, "I am out"), { heard: false });
    await open(house);
    fireEvent.click(ivyDirect());

    await screen.findByText("I am out");
    await say("Can you see this?", "Ivy への発言");
    assert.deepEqual(house.sentDirect, [{ agent: IVY.id, message: { text: "Can you see this?" }, connection: "c-1" }]);
    assert.deepEqual(house.writes, ["POST /api/dms/ivy/say"]);
    assert.deepEqual(house.sources.map(({ url }) => url), ["/api/stream"]);
  });

  it("counts new direct replies on the plan until their conversation is opened", async () => {
    const house = new FakeHouse();
    house.house = withAwayIvy(house);
    house.direct(directSpeech(IVY, "Old history"), { heard: false });
    await open(house);
    ivyDirect();

    const first = directSpeech(IVY, "First reply");
    await act(async () => {
      house.direct(first);
      house.direct(first);
      house.direct(directSpeech(IVY, "Owner's message", LEE));
      house.direct(directSpeech(IVY, "Second reply"));
    });
    const link = screen.getByRole("link", { name: "Ivy との1対1を開く（まだ読んでいない発言 2 件）" });
    assert.match(link.textContent ?? "", /2/);
    fireEvent.click(link);

    await screen.findByText("Second reply");
    await act(async () => house.direct(directSpeech(IVY, "Reply while open")));
    fireEvent.click(screen.getByRole("button", { name: "間取りに戻る" }));
    assert.equal(ivyDirect().textContent, "1対1");
    assert.deepEqual(house.writes, []);
  });

  it("keeps direct history readable after the resident enters a room, but cannot send there", async () => {
    const house = new FakeHouse();
    const inRoom = { ...house.house, direct: [{ agent_id: IVY.id, send: "in-room" as const, sleeping: false, connected: true }] };
    house.house = withAwayIvy(house);
    await open(house);
    fireEvent.click(ivyDirect());
    await act(async () => house.direct(directSpeech(IVY, "Before coming home")));
    await act(async () => house.floor(inRoom));

    await screen.findByText("Before coming home");
    assert.ok(screen.getByText("相手は部屋にいます。1対1では送れません。"));
    assert.equal(screen.getByRole("button", { name: "送信" }).getAttribute("aria-disabled"), "true");
  });

  it("sets a refused direct message aside if the resident entered a room before it arrived", async () => {
    const house = new FakeHouse();
    house.house = withAwayIvy(house);
    await open(house);
    fireEvent.click(ivyDirect());
    house.refusals.say = "agent-in-room";
    await say("Just missed you", "Ivy への発言");

    const unsent = await screen.findByRole("group", { name: "送れなかった発言" });
    within(unsent).getByText("Just missed you");
    within(unsent).getByText("相手は部屋にいます。1対1では送れません。");
    assert.deepEqual(house.sentDirect, []);
  });

  it("explains why an older deployment cannot receive a direct message", async () => {
    const house = new FakeHouse();
    house.house = withAwayIvy(house, { send: "deployment-unsupported" });
    await open(house);
    fireEvent.click(ivyDirect());

    await screen.findByText("相手の配置はまだ1対1に対応していません。");
    assert.equal(screen.getByRole("button", { name: "送信" }).getAttribute("aria-disabled"), "true");
  });

  it("offers to queue direct messages while a supported resident is disconnected", async () => {
    const house = new FakeHouse();
    house.house = withAwayIvy(house, { connected: false });
    await open(house);
    fireEvent.click(ivyDirect());

    await screen.findByText("相手はつながっていません。発言は届け待ちになります。");
    await say("Read it later", "Ivy への発言");
    assert.deepEqual(house.sentDirect[0]?.message, { text: "Read it later" });
  });

  it("shows the sleeping notice only inside the direct conversation", async () => {
    const house = new FakeHouse();
    house.house = withAwayIvy(house, { sleeping: true });
    await open(house);
    assert.equal(screen.queryByText("寝ています。起きたら届きます"), null);
    fireEvent.click(ivyDirect());
    await screen.findByText("寝ています。起きたら届きます");
  });

  it("updates the original direct message when the house reports an expired delivery", async () => {
    const house = new FakeHouse();
    house.house = withAwayIvy(house);
    const pending = { ...directSpeech(IVY, "Did it reach you?", LEE), delivery_status: "pending" } as const;
    house.direct(pending, { heard: false });
    await open(house);
    fireEvent.click(ivyDirect());

    await screen.findByText("Did it reach you?");
    assert.equal(screen.queryByText("配信期限切れ"), null);
    await act(async () => house.direct({ ...pending, delivery_status: "expired" }));
    await screen.findByText("配信期限切れ");
    assert.equal(screen.getAllByText("Did it reach you?").length, 1);
  });

  it("catches up expired deliveries on older loaded pages after the stream reconnects", async () => {
    const house = new FakeHouse();
    house.pageSize = 1;
    house.house = withAwayIvy(house);
    const pending = { ...directSpeech(IVY, "Wait until morning", LEE), delivery_status: "pending" } as const;
    house.direct(pending, { heard: false });
    house.direct(directSpeech(IVY, "A newer reply"), { heard: false });
    await open(house);
    fireEvent.click(ivyDirect());
    fireEvent.click(await screen.findByRole("button", { name: "前の会話を読む" }));
    await screen.findByText("Wait until morning");

    await act(async () => {
      house.drop();
      house.direct({ ...pending, delivery_status: "expired" }, { heard: false });
      house.ready();
    });
    await screen.findByText("配信期限切れ");
  });

  it("links to a valid personal page without reusing the old chat URL", async () => {
    const house = new FakeHouse();
    house.house = { ...withAwayIvy(house), away: [{ ...IVY, personal_url: "https://ivy.example.com/", chat_url: "https://old.example.com/" }, { ...FERN, personal_url: "http://fern.example.com/" }] };
    await open(house);
    assert.equal(screen.getByRole("link", { name: "Ivy の個人ページ（別のタブで開く）" }).getAttribute("href"), "https://ivy.example.com/");
    assert.equal(screen.queryByRole("link", { name: /Fern.*個人ページ/ }), null);
  });

  it("shows a different avatar when the speaker's expression changes and falls back to neutral", async () => {
    const house = new FakeHouse();
    const resident = { ...IVY, avatar_urls: { happy: "https://example.com/happy.webp", neutral: "https://example.com/neutral.webp" } };
    house.house = { ...withAwayIvy(house), away: [resident] };
    house.direct({ ...directSpeech(IVY, "Good news"), expression: "happy" }, { heard: false });
    house.direct({ ...directSpeech(IVY, "Let me think"), expression: "thinking" }, { heard: false });
    await open(house);
    fireEvent.click(ivyDirect());

    const log = await screen.findByRole("region", { name: "Ivy との1対1" });
    await within(log).findByText("Let me think");
    const pictures = [...log.querySelectorAll(".speech-avatar img")].map((image) => image.getAttribute("src"));
    assert.deepEqual(pictures, ["https://example.com/happy.webp", "https://example.com/neutral.webp"]);
  });

  it("blocks a non-image attachment until removed, then lets the user send just the text", async () => {
    const house = await open();
    const picker = screen.getByLabelText("画像を添付する");
    await act(async () => fireEvent.change(picker, { target: { files: [new File(["not a picture"], "letter.png", { type: "image/png" })] } }));
    await screen.findByText(/PNG・JPEG・GIF・WebP の画像だけ/);
    await say("hello");
    assert.deepEqual(house.writes, []);

    fireEvent.click(screen.getByRole("button", { name: "letter.png を外す" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "送信" })));
    assert.deepEqual(house.said[0]?.speech, { text: "hello" });
  });

  it("lets the owner send the remaining four valid images after removing an attachment", async () => {
    const house = await open();
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const files = [new File(["not an image"], "broken.png"), ...[1, 2, 3, 4].map((n) => new File([png], `${n}.png`))];
    await act(async () => fireEvent.change(screen.getByLabelText("画像を添付する"), { target: { files } }));
    await screen.findByText("画像は 4 枚までです。");

    fireEvent.click(screen.getByRole("button", { name: "broken.png を外す" }));
    await say("Four photos");
    await waitFor(() => assert.deepEqual(house.said[0]?.speech.images?.map(({ name }) => name), ["1.png", "2.png", "3.png", "4.png"]));
  });

  it("blocks another send and shows progress until an image send finishes", async () => {
    const house = await open();
    const answer = house.hold("say");
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    await act(async () => fireEvent.change(screen.getByLabelText("画像を添付する"), { target: { files: [new File([png], "photo.png")] } }));
    await say("First message");
    await screen.findByText("送っています…（画像 1 枚）");
    await waitFor(() => assert.equal(house.said.length, 1));
    await say("Next message");
    const send = screen.getByRole("button", { name: "送信" });
    assert.equal(send.getAttribute("aria-disabled"), "true");
    assert.equal(screen.getByLabelText("Livingで話す").textContent, "Next message");
    assert.equal(house.said.length, 1);

    await act(async () => answer.give());
    assert.equal(screen.queryByText("送っています…（画像 1 枚）"), null);
    assert.notEqual(send.getAttribute("aria-disabled"), "true");
  });

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

  it("resends to the remaining addressee only after the person chooses to omit one who left", async () => {
    const house = new FakeHouse();
    const [living, bath] = house.house.rooms;
    const emptyBath = { ...bath!, occupants: [] };
    house.house = { ...house.house, rooms: [{ ...living!, occupants: [...living!.occupants, awake(FERN)] }, emptyBath] };
    await open(house);
    const address = screen.getByRole("button", { name: "@ 宛先" });
    for (const name of [/Ivy/, /Fern/]) {
      fireEvent.click(address);
      fireEvent.click(await screen.findByRole("menuitem", { name }));
    }
    const answer = house.hold("say");
    await say("did you hear?");
    await act(async () => answer.lose());
    assert.deepEqual(house.said[0]?.speech, { text: "did you hear?", to: [IVY.id, FERN.id] });

    const withoutIvy = { ...living!, occupants: [awake(FERN), { ...LEE, connected: true }] };
    await act(async () => house.floor({ ...house.house, rooms: [withoutIvy, emptyBath], away: [IVY] }));

    const unsent = within(myRoom()).getByRole("group", { name: "送れたか確かめられなかった発言" });
    assert.ok(within(unsent).getByText("@Ivy"));
    assert.equal(within(unsent).queryByRole("button", { name: "もう一度送る" }), null);
    assert.equal(house.said.length, 1);
    fireEvent.click(within(unsent).getByRole("button", { name: "Ivyを宛先から外して送る" }));
    assert.deepEqual(house.said[1]?.speech, { text: "did you hear?", to: [FERN.id] });
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

  it("keeps the selected conversation readable while the floor has not confirmed entry", async () => {
    viewport(390);
    const house = new FakeHouse();
    const beforeEntry = house.withLeeIn(undefined);
    house.house = beforeEntry;
    house.happen(speech(LIVING, IVY, "hello from the living room"), { heard: false });
    await open(house);
    const answer = house.hold("enter");

    fireEvent.click(screen.getByRole("button", { name: "Livingに入る" }));
    const heading = await within(readOnlyRoom()).findByRole("heading", { name: "Living" });
    assert.equal(document.activeElement, heading);
    await within(readOnlyRoom()).findByText("hello from the living room");
    await act(async () => {
      house.floor(beforeEntry);
      answer.give();
    });

    assert.equal(window.location.hash, "#/talk/living");
    assert.ok(within(readOnlyRoom()).getByText("hello from the living room"));
    assert.ok(within(readOnlyRoom()).getByText("入室を確認しています。"));
    assert.equal(screen.queryByLabelText("Livingで話す"), null);
    assert.equal(document.activeElement, heading);

    await act(async () => house.floor(house.withLeeIn(LIVING.id)));
    assert.ok(screen.getByLabelText("Livingで話す"));
    assert.equal(document.activeElement, heading);
    await act(async () => house.floor(beforeEntry));
    assert.ok(within(readOnlyRoom()).getByText("この部屋に入室すると発言できます。"));
  });

  it("keeps focus on the earlier history when entry fails", async () => {
    viewport(390);
    const house = new FakeHouse();
    house.house = house.withLeeIn(undefined);
    house.pageSize = 1;
    house.happen(speech(LIVING, IVY, "the first page"), { heard: false });
    house.happen(speech(LIVING, IVY, "the newest page"), { heard: false });
    await open(house);
    house.refusals.enter = "unavailable";
    const letEntryFail = house.stall("enter");
    fireEvent.click(screen.getByRole("button", { name: "Livingに入る" }));
    const older = await within(readOnlyRoom()).findByRole("button", { name: "前の会話を読む" });
    older.focus();

    await act(async () => letEntryFail());

    const conversation = within(readOnlyRoom());
    assert.ok(conversation.getByText("Livingに入れたか確かめられませんでした。"));
    assert.ok(conversation.getByText("the newest page"));
    assert.equal(document.activeElement, older);
  });

  it("announces an entry failure in the conversation's existing status region", async () => {
    const house = new FakeHouse();
    house.house = house.withLeeIn(undefined);
    await open(house);
    house.refusals.enter = "unavailable";
    const letEntryFail = house.stall("enter");
    fireEvent.click(screen.getByRole("button", { name: "Livingに入る" }));
    const conversation = within(readOnlyRoom());
    const confirming = conversation.getByText("入室を確認しています。");
    const status = conversation.getAllByRole("status").find((region) => region.contains(confirming));
    assert.ok(status);

    await act(async () => letEntryFail());

    assert.ok(conversation.getAllByRole("status").includes(status));
    assert.ok(within(status).getByText("Livingに入れたか確かめられませんでした。"));
  });

  it("names the unread count in the current room's button while a PC shows another conversation", async () => {
    viewport(1400);
    window.location.hash = "#/talk/bath";
    const house = await open();
    assert.ok(within(readOnlyRoom()).getByRole("heading", { name: "Bath" }));

    await act(async () => house.happen(speech(LIVING, IVY, "still there?")));

    const tile = screen.getByRole("article", { name: "Living" });
    const button = within(tile).getByRole("button", { name: "会話を開く（まだ読んでいない発言 1 件）" });
    assert.ok(within(button).getByText("1"));
  });

  it("lets the skip link focus the conversation shown instead of the current room", async () => {
    viewport(1100);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Bathを覗く" }));
    const peeked = screen.getByRole("region", { name: "覗いている部屋" });

    fireEvent.click(screen.getByRole("link", { name: "会話へ移動" }));

    assert.equal(document.activeElement, within(peeked).getByRole("heading", { name: /^Bath/ }));
  });

  it("lets the skip link focus the strip that opens the conversation on a phone", async () => {
    viewport(390);
    await open();

    fireEvent.click(screen.getByRole("link", { name: "会話へ移動" }));

    assert.equal(document.activeElement, screen.getByRole("button", { name: "Livingの会話を開く" }));
  });

  it("names the unread count in the strip that opens the conversation on a phone", async () => {
    viewport(390);
    const house = await open();

    await act(async () => house.happen(speech(LIVING, IVY, "still there?")));

    assert.ok(screen.getByRole("button", { name: "Livingの会話を開く（まだ読んでいない発言 1 件）" }));
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
});
