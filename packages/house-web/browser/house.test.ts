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

import type { HousePersonView } from "@penelope/contract";

import { EVENING_BEHIND_MS, type FakeHouse, playEvening, startFakeHouse } from "../dev/house.ts";

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
async function evening(t: TestContext, options: { long?: boolean } = {}): Promise<FakeHouse> {
  const house = await startFakeHouse({ webDir: dist, behindMs: EVENING_BEHIND_MS });
  t.after(() => house.close());
  await playEvening(house, options);
  return house;
}

/** A browser of its own, signed in, with the floor on the screen. */
async function open(t: TestContext, house: FakeHouse, viewport: { width: number; height: number }, as = "lee"): Promise<Page> {
  const phone = viewport.width < 768;
  const context = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone });
  // Before the house: a page left open would go on asking a house that is gone.
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(`${house.origin}/auth/github/start?as=${as}`);
  await page.locator(".plan-tiles").waitFor();
  return page;
}

/** Closes the page and waits until the house has seen its stream close: the wait before leaving starts there. */
async function close(page: Page, house: FakeHouse): Promise<void> {
  const context = page.context();
  await page.close();
  for (;;) {
    const view = (await (await context.request.get(`${house.origin}/api/house`)).json()) as HousePersonView;
    const me = view.rooms.flatMap(({ occupants }) => occupants).find(({ id }) => id === view.you.id);
    if (me?.connected === false) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const field = (page: Page, room: string) => page.getByLabel(`${room}で話す`, { exact: true });
const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");

describe("the house's screen in a browser", () => {
  // ADR-0075, 2: one who closed the screen has left once the wait is over, and is back in the same room on opening it.
  it("leaves the room when the screen stays closed, and is back in it when opened again", async (t) => {
    const house = await evening(t);
    const lee = await open(t, house, PC);
    await lee.getByRole("button", { name: "居間に入る" }).click();
    await field(lee, "居間").waitFor();
    const sam = await open(t, house, PC, "sam");
    await sam.getByRole("button", { name: "居間を覗く" }).click();
    await sam.getByText("Lee が居間に来た").waitFor();

    await close(lee, house);
    await house.advance(31_000);
    await sam.getByText("Lee が居間を出た").waitFor();

    const again = await lee.context().newPage();
    await again.goto(house.origin);
    await field(again, "居間").waitFor();
    assert.equal(await sam.getByText("Lee が居間に来た").count(), 2);
  });

  // ADR-0075, 2: within the wait nothing happened as far as the room is concerned.
  it("records no coming and going when the screen is opened again within the wait", async (t) => {
    const house = await evening(t);
    const lee = await open(t, house, PC);
    await lee.getByRole("button", { name: "居間に入る" }).click();
    await field(lee, "居間").waitFor();

    await close(lee, house);
    await house.advance(20_000);
    const again = await lee.context().newPage();
    await again.goto(house.origin);
    await field(again, "居間").waitFor();
    await house.agent("penelope").say("living", "まだいたんだね");
    await again.locator(".speech-text", { hasText: "まだいたんだね" }).waitFor();

    assert.equal(await again.getByText("Lee が居間に来た").count(), 1);
    assert.equal(await again.getByText("Lee が居間を出た").count(), 0);
  });

  // ADR-0075, 7: whom a speech is addressed to is its own field. The `@` and what was typed after it are not text.
  it("sends an addressee picked with @ with the speech, and not in its text", async (t) => {
    const house = await evening(t);
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
    // The house delivered it as addressed: only then does the agent get a way to answer.
    const delivered = (await house.agent("penelope").sync()).find(({ event }) => event.kind === "speech" && event.text === "聞こえる?");
    assert.deepEqual(delivered?.answer_via, { command: "house say" });
  });

  it("puts the focus in the field of a room entered on a PC, and on the word of being in no room after leaving", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PC);

    await page.getByRole("button", { name: "居間に入る" }).click();
    await field(page, "居間").waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("contenteditable") === "true");

    await page.getByRole("button", { name: "部屋を出る" }).click();
    await page.getByText("いまはどの部屋にもいません").waitFor();
    await page.waitForFunction(() => document.activeElement?.tagName === "H2");
    assert.equal(await focused(page), "いまはどの部屋にもいません");
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

  it("takes the way past the floor to the room looked into where that is the conversation shown", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, { width: 1100, height: 800 });
    await page.getByRole("button", { name: "居間に入る" }).click();
    await field(page, "居間").waitFor();
    await page.getByRole("button", { name: "風呂を覗く" }).click();
    await page.getByText("覗いています").waitFor();

    await page.getByRole("link", { name: "会話へ移動" }).focus();
    await page.keyboard.press("Enter");

    assert.match(await focused(page), /^風呂/);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H2");
  });

  it("takes the way past the floor to the strip that opens the conversation on a phone", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PHONE);
    await page.getByRole("button", { name: "居間に入る" }).click();
    await page.getByRole("button", { name: "間取りに戻る" }).click();
    await page.getByRole("region", { name: "自分のいる部屋" }).waitFor({ state: "detached" });

    await page.getByRole("link", { name: "会話へ移動" }).focus();
    await page.keyboard.press("Enter");

    assert.equal(await focused(page), "居間の会話を開く");
  });

  it("names the count of what was not read in the name of the strip that shows it", async (t) => {
    const house = await evening(t);
    const page = await open(t, house, PHONE);
    await page.getByRole("button", { name: "居間に入る" }).click();
    await page.getByRole("button", { name: "間取りに戻る" }).click();

    await house.agent("penelope").say("living", "まだいる?");

    await page.getByRole("button", { name: "居間の会話を開く（まだ読んでいない発言 1 件）" }).waitFor();
  });
});
