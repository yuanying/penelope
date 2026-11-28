// Pictures of the house's screen, taken in Chromium over the made-up house
// (dev/house.ts) at the width of a PC and of a phone: the floor, a room
// entered, an addressee picked, a speech that did not reach a sleeper, a
// room looked into, no room, a dropped line, and the dark theme.
//
//   CHROMIUM=<path to chrome> node --conditions=penelope-source dev/shots.ts <directory>
//
// Nothing in CI runs it.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

import { buildUi } from "../build.ts";
import { EVENING_BEHIND_MS, type FakeHouse, PERSON_AVATAR, playEvening, startFakeHouse } from "./house.ts";

const executablePath = process.env.CHROMIUM;
const out = process.argv[2];
if (!executablePath || !out) throw new Error("usage: CHROMIUM=<path to chrome> node dev/shots.ts <directory>");
mkdirSync(out, { recursive: true });

const dist = path.join(import.meta.dirname, "../dist");
await buildUi(dist, { minify: true, nodeEnv: "production" });

const PC = { width: 1400, height: 800 };
const NARROW_PC = { width: 1100, height: 800 };
const PHONE = { width: 390, height: 844 };
/** A person's picture in GitHub's place: a plain square with a face drawn in lines. */
const FACE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2d6a4f"/><circle cx="32" cy="26" r="11" fill="#d8f3dc"/><path d="M10 64a22 22 0 0 1 44 0z" fill="#d8f3dc"/></svg>`;

const browser: Browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-crash-reporter", "--no-zygote"] });
const problems: string[] = [];

const contexts: BrowserContext[] = [];

async function evening(): Promise<FakeHouse> {
  const house = await startFakeHouse({ webDir: dist, behindMs: EVENING_BEHIND_MS });
  await playEvening(house, { long: true });
  return house;
}

/** The pages go before the house they show, so that none is left asking a house that is gone. */
async function end(house: FakeHouse): Promise<void> {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await house.close();
}

async function open(house: FakeHouse, viewport: { width: number; height: number }, { dark = false, as = "lee" } = {}): Promise<Page> {
  const phone = viewport.width < 768;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: dark ? "dark" : "light", hasTouch: phone, isMobile: phone });
  contexts.push(context);
  await context.route(`${PERSON_AVATAR}**`, (route) => route.fulfill({ contentType: "image/svg+xml", body: FACE }));
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    // A stream that is cut on purpose ends in the middle of a chunk.
    if (message.type() === "error" && !message.text().includes("ERR_INCOMPLETE_CHUNKED_ENCODING")) problems.push(`console: ${message.text()}`);
  });
  await page.goto(`${house.origin}/auth/github/start?as=${as}`);
  await page.locator(".plan-tiles").waitFor();
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(out!, `${name}.png`) });
  console.log(name);
}

/** Lee comes into the living room, is welcomed, and asks the room something that does not reach Aki, who is asleep. */
async function settle(house: FakeHouse, page: Page): Promise<void> {
  const phone = (page.viewportSize()?.width ?? 0) < 768;
  await page.getByRole("button", { name: "居間に入る" }).click();
  await page.getByLabel("居間で話す", { exact: true }).waitFor();
  await house.agent("penelope").say("living", "おかえりなさい。アキはこたつで寝ちゃった", ["lee"]);
  await house.advance(2 * 60_000);
  await page.getByLabel("居間で話す", { exact: true }).click();
  await page.keyboard.type("ただいま。みんな今日はどうだった?");
  if (phone) await page.getByRole("button", { name: "送信" }).click();
  else await page.keyboard.press("Enter");
  await page.getByText("届いていません").waitFor();
  await house.advance(60_000);
  await house.agent("penelope").say("living", "私は記憶の整理をしていたよ。ミャオはさっきからお風呂", ["lee"]);
  await page.getByText("私は記憶の整理").first().waitFor();
}

const only = process.argv.slice(3);
const wanted = (name: string) => only.length === 0 || only.includes(name);

if (wanted("pc")) {
  const house = await evening();
  const page = await open(house, PC);
  await shot(page, "pc-01-floor-in-no-room");
  await settle(house, page);
  await shot(page, "pc-02-in-the-living-room");

  await page.getByLabel("居間で話す", { exact: true }).click();
  await page.keyboard.type("@");
  await page.getByRole("option").first().waitFor();
  await shot(page, "pc-03-addressee-menu");
  await page.keyboard.type("あ");
  await page.keyboard.press("Enter");
  await page.keyboard.type("起きてる?");
  await shot(page, "pc-04-addressee-line");
  await page.keyboard.press("Enter");
  await page.locator(".speech-text", { hasText: "起きてる?" }).waitFor();
  await shot(page, "pc-05-addressed-speech");

  await page.getByRole("button", { name: "なつみの部屋を覗く" }).click();
  await page.getByText("覗いています").waitFor();
  await shot(page, "pc-06-peek-beside");
  await page.setViewportSize(NARROW_PC);
  await page.getByRole("button", { name: "風呂を覗く" }).click();
  await page.getByText("満員なので入れません").waitFor();
  await house.agent("penelope").say("living", "お風呂、まだミャオが入ってるよ");
  await shot(page, "pc-07-peek-in-place-full-room");
  await page.getByRole("button", { name: /居間に戻る/ }).click();
  await page.setViewportSize(PC);

  await page.getByRole("button", { name: "前の会話を読む" }).scrollIntoViewIfNeeded();
  await shot(page, "pc-08-older-button");

  house.cut();
  await page.getByText("接続が切れました").waitFor();
  await shot(page, "pc-09-line-down");
  house.mend();
  await page.getByRole("button", { name: "部屋を出る" }).click({ timeout: 20_000 });
  await page.getByText("いまはどの部屋にもいません").waitFor();
  await shot(page, "pc-10-in-no-room");
  await end(house);
}

if (wanted("pc-dark")) {
  const house = await evening();
  const page = await open(house, PC, { dark: true });
  await settle(house, page);
  await page.getByRole("button", { name: "なつみの部屋を覗く" }).click();
  await page.getByText("覗いています").waitFor();
  await shot(page, "pc-11-dark");
  await end(house);
}

if (wanted("phone")) {
  const house = await evening();
  const page = await open(house, PHONE);
  await shot(page, "phone-01-floor-in-no-room");
  await settle(house, page);
  await shot(page, "phone-02-in-the-living-room");
  await page.getByRole("button", { name: "この部屋の住人を見る" }).click();
  await page.getByRole("dialog").waitFor();
  await shot(page, "phone-03-residents-sheet");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "@ 宛先" }).click();
  await shot(page, "phone-04-addressee-menu");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "間取りに戻る" }).click();
  await shot(page, "phone-05-floor");
  await page.getByRole("button", { name: "風呂を覗く" }).click();
  await page.getByText("覗いています").waitFor();
  await house.agent("penelope").say("living", "お風呂、まだミャオが入ってるよ");
  await shot(page, "phone-06-peek-full-room");
  await end(house);
}

if (wanted("phone-dark")) {
  const house = await evening();
  const page = await open(house, PHONE, { dark: true });
  await settle(house, page);
  await shot(page, "phone-07-dark");
  await end(house);
}

if (wanted("house-first")) {
  const house = await evening();
  const sayaka = house.agent("sayaka");
  const picture = { name: "似顔絵.webp", data: readFileSync(new URL("../../../assets/avatars/sayaka/icons/happy.webp", import.meta.url)).toString("base64") };
  await sayaka.reply({ text: "散歩の途中で似顔絵を描いたよ。どうかな？", expression: "happy", images: [picture] });

  const pc = await open(house, PC);
  const direct = pc.getByRole("link", { name: "さやかとの1対1を開く" });
  await direct.scrollIntoViewIfNeeded();
  await shot(pc, "house-first-pc-away");
  await direct.click();
  await pc.getByText("散歩の途中で似顔絵を描いたよ。どうかな？").waitFor();
  await shot(pc, "house-first-pc-direct");

  const phone = await open(house, PHONE, { dark: true });
  await phone.getByRole("link", { name: "さやかとの1対1を開く" }).click();
  await sayaka.sync({ mood: null, sleepiness: 90, sleep: { state: "asleep", wake_at: new Date(house.now() + 3_600_000).toISOString() } });
  await phone.getByText("寝ています。起きたら届きます").waitFor();
  await phone.getByLabel("さやかへの発言").fill("いいね。起きたらこれも見てね。");
  await phone.getByLabel("画像を添付する").setInputFiles({ name: "お返し.webp", mimeType: "image/webp", buffer: Buffer.from(picture.data, "base64") });
  await phone.getByText("お返し.webp").waitFor();
  await shot(phone, "house-first-phone-attachment");
  await phone.getByRole("button", { name: "送信" }).click();
  await phone.locator(".speech-text", { hasText: "いいね。起きたらこれも見てね。" }).waitFor();
  await house.advance(24 * 3_600_000 + 1_000);
  await phone.getByText("配信期限切れ").waitFor();
  await shot(phone, "house-first-phone-expired");

  await sayaka.enter("living");
  await pc.getByText("相手は部屋にいます。1対1では送れません。").waitFor();
  await shot(pc, "house-first-pc-read-only");
  await end(house);
}

if (wanted("return")) {
  // The room to come back to filled up while the screen was closed.
  const house = await evening();
  await house.agent("myao").enter("living");
  const first = await open(house, PC);
  await first.getByRole("button", { name: "風呂に入る" }).click();
  await first.getByLabel("風呂で話す", { exact: true }).waitFor();
  await first.close();
  // The house sees the stream close, waits 30 seconds by its clock, and looks at the clock once a second.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await house.advance(31_000);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const sam = await open(house, PC, { as: "sam" });
  await sam.getByRole("button", { name: "風呂に入る" }).click();
  await sam.getByLabel("風呂で話す", { exact: true }).waitFor();
  const lee = await open(house, PC);
  await lee.getByText("風呂は満員なので").waitFor();
  await shot(lee, "pc-12-no-way-back-full");
  await end(house);
}

await browser.close();
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
}
