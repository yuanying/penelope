// What only a browser that lays the page out can tell: the widths on the
// screen. happy-dom (test/) reads the styles but measures nothing, so the mark
// of what made her speak once ran past the reply's column while its tests
// passed (docs/design/README.md, 13).
//
// It opens the built UI (dist/) in Chromium over a stub of the backend's API,
// at the width of a PC and of a phone. It needs a Chromium, so `make test`
// never runs it: `make test-browser CHROMIUM=<path to chrome>`.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { type Browser, chromium, type Page } from "playwright-core";

import type { HistoryEntry, Trigger } from "@penelope/contract";

import { LONG_PATH, MEMORY_DAY, memoryDiff, memoryScene } from "../dev/memory.ts";

const executablePath = process.env.CHROMIUM;
if (!executablePath) throw new Error("set CHROMIUM to the path of a Chromium or Chrome");

const dist = path.join(import.meta.dirname, "../dist");
// Longer than the widest column (720px) can show.
const LONG = "This content was flagged for possible cybersecurity risk and the turn was stopped before it could finish. ".repeat(3);

const reply = (id: string, text: string, trigger?: Trigger): HistoryEntry => ({
  kind: "agent",
  id,
  at: new Date().toISOString(),
  text,
  agent: "main",
  expression: "normal",
  ...(trigger ? { trigger } : {}),
});

/** What the stub of the backend answers: her name, and the history newest first. */
let agentName = "ペネロペ";
let history: HistoryEntry[] = [];
const memory = memoryScene(Date.now());

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

function stub(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/agent") return json({ name: agentName });
    if (url.pathname === "/api/agents") return json({ agents: [] });
    if (url.pathname === "/api/history") return json({ entries: history });
    if (url.pathname === "/api/push") return json({});
    if (url.pathname === "/api/memory") return json(memory.overview);
    if (url.pathname === `/api/memory/changes/${MEMORY_DAY}`) return json(memory.changes[0]);
    if (url.pathname === `/api/memory/changes/${MEMORY_DAY}/diff`) return json(memoryDiff(url.searchParams.get("path") ?? ""));
    if (url.pathname === "/api/stream") {
      // Kept open and quiet, as when nothing happens.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(":\n\n");
      return;
    }
    let file = path.join(dist, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
    if (!file.startsWith(dist) || !existsSync(file)) file = path.join(dist, "index.html");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
}

let server: Server;
let browser: Browser;
let origin: string;

before(async () => {
  server = stub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
});

/** The page at that width, once the replies are on it. */
async function open(width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(origin);
  await page.waitForSelector(".reply-bubble");
  return page;
}

type Box = { left: number; right: number; top: number; bottom: number };

/** The boxes of the line before the only reply: the mark, and the line it is in the middle of. */
async function boxes(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      const { left, right, top, bottom } = el!.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    const name = document.querySelector(".timeline-event")!;
    const words = name.querySelector(".reply-trigger-words")!;
    return {
      mark: box(name.querySelector(".reply-trigger")),
      reply: box(name),
      cut: words.scrollWidth > words.clientWidth,
    };
  }) as Promise<{ mark: Box; reply: Box; cut: boolean }>;
}

for (const [screen, width] of [
  ["a PC", 1400],
  ["a phone", 390],
] as const) {
  it(`wraps an unbroken diff line and path within the memory pane on ${screen}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(`${origin}/#/memory/changes/${MEMORY_DAY}`);
      const added = page.locator('.memory-diff-line[data-kind="added"] code').first();
      await added.waitFor();
      assert.equal(await page.locator(".memory-diff-title code").first().textContent(), LONG_PATH);
      const measured = await added.evaluate((code) => {
        const pane = code.closest(".memory-scroll")!;
        return { wraps: code.getBoundingClientRect().height > parseFloat(getComputedStyle(code).lineHeight), overflow: pane.scrollWidth - pane.clientWidth };
      });
      assert.ok(measured.wraps, "the long line takes more than one line");
      assert.ok(measured.overflow <= 0, `the memory pane overflows by ${measured.overflow}px`);
    } finally {
      await page.close();
    }
  });

  describe(`the mark of what made her speak, on ${screen}`, () => {
    it("is cut within the reply's column when its words are long", async () => {
      agentName = "ペネロペ";
      history = [reply("r-1", "返事", { source: "self", summary: LONG })];
      const page = await open(width);
      const { mark, reply: column, cut } = await boxes(page);
      await page.close();
      assert.ok(cut, "the words are cut");
      assert.ok(mark.right <= column.right, `the mark ends at ${mark.right}, past the reply's ${column.right}`);
    });

    it("is whole when it is short", async () => {
      agentName = "ペネロペ";
      history = [reply("r-1", "返事", { source: "cron", summary: "毎朝 9:00" })];
      const page = await open(width);
      const { mark, reply: column, cut } = await boxes(page);
      await page.close();
      assert.ok(!cut, "the words are whole");
      assert.ok(mark.right <= column.right, `the mark ends at ${mark.right}, past the reply's ${column.right}`);
    });
  });
}

describe("an address in a reply", () => {
  it("is underlined, so that it is told from the words around it", async () => {
    agentName = "ペネロペ";
    history = [reply("r-1", "PR を作った。\nhttps://github.com/example/repo/pull/1")];
    const page = await open(1400);
    const decoration = await page.$eval("a[href='https://github.com/example/repo/pull/1']", (a) => getComputedStyle(a).textDecorationLine);
    await page.close();
    assert.equal(decoration, "underline");
  });
});
