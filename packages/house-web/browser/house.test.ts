// What only a browser and the real house can tell: where the focus goes,
// how the rooms are laid out at each width, how a long record scrolls, and
// what the house makes of a screen that is closed and opened again. happy-dom
// (test/) lays nothing out and stands on a stand-in for the house.
//
// It opens the built screen (dist/) in Chromium over the made-up house
// (dev/house.ts), whose server is the real one. It needs a Chromium, so
// `make test` never runs it: `make test-browser CHROMIUM=<path to chrome>`.
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";

import { type Browser, chromium, type Page } from "playwright-core";

import type { HouseDelivery, HousePersonView } from "@penelope/contract";

import { EVENING_BEHIND_MS, type FakeHouse, type FakeHouseOptions, playEvening, startFakeHouse } from "../dev/house.ts";

const executablePath = process.env.CHROMIUM;
if (!executablePath) throw new Error("set CHROMIUM to the path of a Chromium or Chrome");

const dist = path.join(import.meta.dirname, "../dist");
const PC = { width: 1400, height: 800 };
const PHONE = { width: 390, height: 844 };

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-crash-reporter", "--no-zygote"] });
});
after(() => browser.close());

/** The evening of dev/house.ts: Penelope and sleeping Aki in the living room, Myao in the bath, which holds one. */
async function evening(t: TestContext, options: { long?: boolean } & Pick<FakeHouseOptions, "onDelivery"> = {}): Promise<FakeHouse> {
  const house = await startFakeHouse({ webDir: dist, behindMs: EVENING_BEHIND_MS, onDelivery: options.onDelivery });
  t.after(() => house.close());
  await playEvening(house, options);
  return house;
}

/** A browser of its own, signed in, with the floor on the screen. */
async function open(t: TestContext, house: FakeHouse, viewport: { width: number; height: number }, as = "lee", prepare?: (page: Page) => Promise<unknown>): Promise<Page> {
  const phone = viewport.width < 768;
  const context = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone });
  // Before the house: a page left open would go on asking a house that is gone.
  t.after(() => context.close());
  const page = await context.newPage();
  await prepare?.(page);
  await page.goto(`${house.origin}/auth/github/start?as=${as}`);
  await page.locator(".plan-tiles").waitFor();
  return page;
}

const field = (page: Page, room: string) => page.getByLabel(`${room}で話す`, { exact: true });
const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");

describe("the house's screen in a browser", () => {
  it("reads a speech sent while the screen was closed when opened again", async (t) => {
    const house = await evening(t);
    const lee = await open(t, house, PC);
    await lee.getByRole("button", { name: "居間に入る" }).click();
    await field(lee, "居間").waitFor();
    const context = lee.context();
    await lee.close();

    await house.agent("penelope").say("living", "あとで読んでね");

    const again = await context.newPage();
    await again.goto(house.origin);
    await again.locator(".speech-text", { hasText: "あとで読んでね" }).waitFor();
  });

  // ADR-0075, 7: whom a speech is addressed to is its own field. The `@` and what was typed after it are not text.
  it("sends an addressee picked with @ even when keepalive acknowledges the delivery first", { timeout: 15_000 }, async (t) => {
    let received!: (delivery: HouseDelivery) => void;
    const delivery = new Promise<HouseDelivery>((resolve) => (received = resolve));
    const house = await evening(t, {
      onDelivery: (agent, delivered) => {
        const { event } = delivered;
        if (agent === "penelope" && event.kind === "speech" && event.actor.id === "lee" && event.text === "聞こえる?") {
          received(delivered);
        }
      },
    });
    const page = await open(t, house, PC);
    await page.getByRole("button", { name: "居間に入る" }).click();
    await field(page, "居間").click();

    await page.keyboard.type("@ぺね");
    await page.getByRole("option", { name: /ペネロペ/ }).waitFor();
    await page.keyboard.press("Enter");
    await page.keyboard.type("聞こえる?");
    await page.keyboard.press("Enter");

    const said = page.locator(".speech-text", { hasText: "聞こえる?" });
    await said.waitFor();
    assert.equal(await said.textContent(), "@ペネロペ 聞こえる?");
    // Let the automatic keepalive receive and acknowledge this speech before an explicit sync.
    // Its pending queue is consumable, not a record of everything the agent received.
    const delivered = await delivery;
    const pending = await house.agent("penelope").sync();
    assert.equal(pending.some(({ event }) => event.id === delivered.event.id), false);
    // The callback observes both automatic and explicit syncs, even after their pending queues were acknowledged.
    assert.deepEqual(delivered.answer_via, { command: "house say" });
  });

  it("focuses the conversation heading on a PC when entering and leaving", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PC);

    await page.getByRole("button", { name: "居間に入る" }).click();
    await field(page, "居間").waitFor();
    assert.equal(await focused(page), "居間");

    await page.getByRole("button", { name: "部屋を出る" }).click();
    await page.getByText("いまはどの部屋にもいません").waitFor();
    await page.waitForFunction(() => document.activeElement?.tagName === "H2");
    assert.equal(await focused(page), "いまはどの部屋にもいません");
  });

  it("opens the room on a phone and focuses its name before the house handles entry", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PHONE);
    await page.getByRole("button", { name: "ミャオの部屋を覗く" }).click();
    let enter!: () => void;
    const pending = new Promise<void>((resolve) => (enter = resolve));
    await page.route("**/api/rooms/myao-room/enter", async (route) => {
      await pending;
      await route.continue();
    });
    t.after(enter);

    await page.getByRole("button", { name: "ここに入る" }).click();
    const conversation = page.getByRole("region", { name: "読み取り専用の会話" });
    await conversation.getByRole("heading", { name: "ミャオの部屋", exact: true }).waitFor({ timeout: 2_000 });
    assert.equal(await page.evaluate(() => window.location.hash), "#/talk/myao-room");
    assert.equal(await focused(page), "ミャオの部屋");
    assert.equal(await field(page, "ミャオの部屋").count(), 0);

    enter();
    await field(page, "ミャオの部屋").waitFor();
    assert.equal(await focused(page), "ミャオの部屋");
  });

  it("keeps the selected record readable when entry succeeds before the floor confirms it", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PHONE, "lee", (page) => page.addInitScript(() => {
      window.EventSource = class extends EventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          let held: string | undefined;
          let released = false;
          this.addEventListener("house", (event: MessageEvent<string>) => {
            const floor = JSON.parse(event.data) as HousePersonView;
            const entered = floor.rooms.some(({ occupants }) => occupants.some(({ id }) => id === floor.you.id));
            if (entered && !released) {
              event.stopImmediatePropagation();
              held = event.data;
            }
          });
          window.addEventListener("release-floor", () => {
            released = true;
            if (held !== undefined) this.dispatchEvent(new MessageEvent("house", { data: held }));
          }, { once: true });
        }
      };
    }));
    let enter!: () => void;
    const pending = new Promise<void>((resolve) => (enter = resolve));
    await page.route("**/api/rooms/living/enter", async (route) => {
      await pending;
      await route.continue();
    });
    t.after(enter);

    await page.getByRole("button", { name: "居間に入る" }).click();
    const speech = page.getByText("そのまま寝ちゃいそうだね", { exact: true });
    await speech.waitFor();
    const confirming = page.getByText("入室を確認しています。", { exact: true });
    await confirming.waitFor();
    await house.agent("aki").sync({ mood: null, sleepiness: 5, sleep: { state: "awake" } });
    await page.getByText("ペネロペ・アキ", { exact: true }).waitFor();
    const response = page.waitForResponse("**/api/rooms/living/enter");
    enter();
    const entered = await response;
    assert.equal(entered.status(), 200);
    assert.equal(await entered.finished(), null);

    assert.ok(await confirming.isVisible());
    assert.ok(await speech.isVisible());
    assert.equal(await field(page, "居間").count(), 0);

    await page.evaluate(() => window.dispatchEvent(new Event("release-floor")));
    await field(page, "居間").waitFor();
  });

  it("shows the entry failure in a status region without covering the earlier history", async (t) => {
    const house = await evening(t, { long: true });
    const page = await open(t, house, PHONE);
    let fail!: () => void;
    const pending = new Promise<void>((resolve) => (fail = resolve));
    await page.route("**/api/rooms/living/enter", async (route) => {
      await pending;
      await route.fulfill({ status: 503, json: { error: "unavailable" } });
    });
    t.after(fail);

    await page.getByRole("button", { name: "居間に入る" }).click();
    const older = page.getByRole("button", { name: "前の会話を読む" });
    await older.focus();
    fail();
    const conversation = page.getByRole("region", { name: "読み取り専用の会話" });
    const failure = conversation.getByRole("status").filter({ hasText: "居間に入れたか確かめられませんでした。" });
    await failure.waitFor();

    assert.match(await failure.ariaSnapshot(), /- status:[\s\S]*居間に入れたか確かめられませんでした。/);
    assert.ok(await older.evaluate((button) => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    }), "the notice covers the focused history button");
    assert.equal(await field(page, "居間").count(), 0);
  });

  it("leaves the peek and its focus alone when Forward overtakes a pending entry", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PC);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    await page.route((url) => url.pathname === "/api/stream" && url.searchParams.has("peek"), async (route) => {
      await blocked;
      await route.abort();
    });
    t.after(release);
    await page.getByRole("button", { name: "居間を覗く" }).click();
    await page.getByRole("button", { name: "風呂を覗く" }).click();
    await page.goBack();
    await page.setViewportSize(PHONE);
    let enter!: () => void;
    const pending = new Promise<void>((resolve) => (enter = resolve));
    await page.route("**/api/rooms/living/enter", async (route) => {
      await pending;
      await route.continue();
    });
    t.after(enter);

    await page.getByRole("button", { name: "ここに入る" }).click();
    await page.goForward();
    const heading = page.getByRole("region", { name: "覗いている部屋" }).getByRole("heading", { name: /^風呂/ });
    await heading.focus();
    const response = page.waitForResponse("**/api/rooms/living/enter");
    enter();
    assert.equal((await response).status(), 200);
    await page.getByRole("button", { name: "居間に戻る" }).waitFor({ timeout: 2_000 });

    assert.equal(await page.evaluate(() => window.location.hash), "#/peek/bath");
    assert.match(await focused(page), /^風呂/);
  });

  it("keeps every speech between peeking and entering even when a peek request cannot connect", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PHONE);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    await page.route((url) => url.pathname === "/api/stream" && url.searchParams.has("peek"), async (route) => {
      await blocked;
      await route.continue();
    });
    t.after(release);
    await house.agent("penelope").say("living", "覗く前の発言");
    await page.getByRole("button", { name: "居間を覗く" }).click();
    await page.getByText("覗く前の発言", { exact: true }).waitFor();

    const texts = Array.from({ length: 60 }, (_, index) => `入る前の発言 ${index + 1}`);
    for (const text of texts) await house.agent("penelope").say("living", text);
    await page.getByRole("button", { name: "ここに入る" }).click();
    await page.getByText("Lee が居間に来た").waitFor();
    release();
    await field(page, "居間").waitFor();
    await page.getByText(texts.at(-1)!, { exact: true }).waitFor();

    const between = page.locator(".speech-text").filter({ hasText: /^入る前の発言 / });
    assert.deepEqual(await between.allTextContents(), texts);
  });

  it("keeps the focus inside the sheet of the room's residents on a phone, and gives it back on closing", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PHONE);
    await page.getByRole("button", { name: "居間に入る" }).click();
    await field(page, "居間").waitFor();

    await page.getByRole("button", { name: "この部屋の住人を見る" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "部屋を出る" }).waitFor();
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press("Tab");
      assert.ok(await page.evaluate(() => document.activeElement?.closest("dialog") !== null), `the focus left the sheet at Tab ${press + 1}`);
    }

    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "この部屋の住人を見る");
  });

  it("gives the focus back to the button that looked into a room when the room is closed", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PHONE);

    await page.getByRole("button", { name: "風呂を覗く" }).click();
    await page.getByText("覗いています").waitFor();
    await page.waitForFunction(() => document.activeElement?.tagName === "H2");

    await page.getByRole("button", { name: "覗くのをやめる" }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "風呂を覗く");
  });

  // The decision of 2026-11-27: side by side on a PC, and in the place of the person's room where the width is short.
  it("sets a room looked into beside the person's own from 1200px, and in its place below", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PC);
    await page.getByRole("button", { name: "居間に入る" }).click();
    await field(page, "居間").waitFor();
    await page.getByRole("button", { name: "なつみの部屋を覗く" }).click();
    const peeked = page.getByRole("region", { name: "覗いている部屋" });
    const mine = page.getByRole("region", { name: "自分のいる部屋" });
    await peeked.waitFor();

    const [left, right] = [await peeked.boundingBox(), await mine.boundingBox()];
    assert.ok(left && right && left.x + left.width <= right.x + 1, "the room looked into stands before the person's own");

    await page.setViewportSize({ width: 1100, height: 800 });
    await mine.waitFor({ state: "detached" });
    assert.ok(await peeked.getByRole("button", { name: "居間に戻る" }).isVisible());
  });

  // The rows of a long record are laid out late; when the newest ones were too, the record lost its end as speeches came in.
  it("follows the end of a long record as speeches come one after another", async (t) => {
    const house = await evening(t, { long: true });
    const page = await open(t, house, PC);
    await page.getByRole("button", { name: "居間に入る" }).click();
    await field(page, "居間").waitFor();

    for (const text of ["ひとつめ", "ふたつめ", "みっつめ"]) await house.agent("penelope").say("living", text);

    const last = page.locator(".speech-text", { hasText: "みっつめ" });
    await last.waitFor();
    await page.waitForFunction(() => {
      const record = document.querySelector(".room-talk .astryx-chat-layout")!;
      return record.scrollHeight - record.scrollTop - record.clientHeight < 2;
    });
    assert.ok(await last.isVisible());
  });

  it("opens a long record at its end, and keeps what was read where it was when an older page is read", async (t) => {
    const house = await evening(t, { long: true });
    const page = await open(t, house, PC);
    await page.getByRole("button", { name: "居間に入る" }).click();
    const newest = page.getByText("Lee が居間に来た");
    await newest.waitFor();
    const record = page.locator(".room-talk .astryx-chat-layout");
    await page.waitForFunction(() => {
      const element = document.querySelector(".room-talk .astryx-chat-layout")!;
      return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
    });

    const older = page.getByRole("button", { name: "前の会話を読む" });
    await older.scrollIntoViewIfNeeded();
    const oldestHeld = page.locator(`[data-speech="${await page.locator("[data-speech]").first().getAttribute("data-speech")}"]`);
    const topIn = async () => (await oldestHeld.boundingBox())!.y - (await record.boundingBox())!.y;
    const before = await topIn();
    await older.click();
    await page.getByText("洗濯物の話 その 1", { exact: true }).waitFor({ state: "attached" });

    assert.ok(Math.abs((await topIn()) - before) <= 2, `the row moved from ${before}px to ${await topIn()}px`);
  });

  // A touch keyboard has no Shift: Enter is how a line is broken there, and only the button sends.
  it("breaks the line on Enter on a phone, and sends the lines with the button", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PHONE);
    await page.getByRole("button", { name: "居間に入る" }).click();
    await field(page, "居間").click();

    await page.keyboard.type("一行目");
    await page.keyboard.press("Enter");
    await page.keyboard.type("二行目");
    assert.equal(await page.locator(".speech-text", { hasText: "一行目" }).count(), 0);
    await page.getByRole("button", { name: "送信" }).click();

    const said = page.locator(".speech-text", { hasText: "二行目" });
    await said.waitFor();
    assert.equal(await said.textContent(), "一行目\n二行目");
  });

  it("says of a candidate to address whether they sleep now, not when the person came in", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PC);
    await page.getByRole("button", { name: "居間に入る" }).click();
    await field(page, "居間").click();

    await house.agent("aki").sync({ mood: null, sleepiness: 5, sleep: { state: "awake" } });
    await page.getByRole("article", { name: "居間" }).getByText(/^寝ている・/).waitFor({ state: "detached" });
    await page.keyboard.type("@あき");

    const candidate = page.getByRole("option", { name: /アキ/ });
    await candidate.waitFor();
    assert.equal(await candidate.textContent(), "アキ");
  });

  it("says of a candidate that is on the screen that they woke", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PC);
    await page.getByRole("button", { name: "居間に入る" }).click();
    await field(page, "居間").click();
    await page.keyboard.type("@あき");
    const candidate = page.getByRole("option", { name: /アキ/ });
    await candidate.getByText("寝ている・届かない").waitFor();

    await house.agent("aki").sync({ mood: null, sleepiness: 5, sleep: { state: "awake" } });

    await candidate.getByText("寝ている・届かない").waitFor({ state: "detached" });
  });

  it("no longer offers a resident in the open @ menu after they leave", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PC);
    await page.getByRole("button", { name: "居間に入る" }).click();
    const input = field(page, "居間");
    await input.click();
    await page.keyboard.type("聞きたい @あき");
    const candidate = page.getByRole("option", { name: /アキ/ });
    await candidate.waitFor();

    await house.agent("aki").leave();

    await candidate.waitFor({ state: "detached", timeout: 2_000 });
    assert.equal(await focused(page), "居間で話す");
    assert.equal(await input.textContent(), "聞きたい @あき");
  });

  /** Says it in the living room; the house records it, and its answer is lost on the way. */
  async function sayUnanswered(page: Page): Promise<void> {
    await page.route("**/api/rooms/living/say", async (route) => {
      await route.fetch();
      await route.abort();
    }, { times: 1 });
    await page.getByRole("button", { name: "送信" }).click();
    await page.getByRole("group", { name: "送れたか確かめられなかった発言" }).waitFor();
  }

  it("leaves the record to be read on a phone beside a long speech that got no answer", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PHONE);
    await page.getByRole("button", { name: "居間に入る" }).click();
    await field(page, "居間").click();
    for (let line = 1; line <= 60; line += 1) {
      await page.keyboard.type(`${line} 行目`);
      await page.keyboard.press("Enter");
    }
    await sayUnanswered(page);

    const record = (await page.locator(".room-talk .astryx-chat-layout").boundingBox())!;
    const bottom = (await page.locator(".room-bottom").boundingBox())!;
    assert.ok(bottom.y - record.y >= PHONE.height / 3, `only ${Math.round(bottom.y - record.y)}px of the record are left above what stands over it`);
  });

  // The screen puts events where the house's record has them, by the place the house gives each of them.
  it("shows a room's speeches in the house's order when the stream brought them before the record was read", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PC);
    let through!: () => void;
    const stalled = new Promise<void>((resolve) => (through = resolve));
    await page.route("**/api/rooms/penelope-room/history", async (route) => {
      await stalled;
      await route.continue();
    });
    await page.getByRole("button", { name: "ペネロペの部屋に入る" }).click();
    await field(page, "ペネロペの部屋").waitFor();
    await house.agent("penelope").enter("penelope-room");
    for (let line = 1; line <= 51; line += 1) await house.agent("penelope").say("penelope-room", `${line} つめ`);
    await page.locator(".speech-text", { hasText: /^51 つめ$/ }).waitFor();

    // The record holds 53 events, so the reading takes its newest page and the one before it.
    const read = page.waitForResponse((response) => response.url().includes("/penelope-room/history?before="));
    through();
    await (await read).finished();
    await page.evaluate(() => new Promise(requestAnimationFrame));

    assert.deepEqual(await page.locator(".speech-text").allTextContents(), Array.from({ length: 51 }, (_, index) => `${index + 1} つめ`));
  });
});
