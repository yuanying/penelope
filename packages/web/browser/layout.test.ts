// Regression coverage for wrapping long diff lines in a real browser.
// It opens the built UI (dist/) in Chromium over a stub of the backend's API,
// at the width of a PC and of a phone. It needs a Chromium, so `make test`
// never runs it: `make test-browser CHROMIUM=<path to chrome>`.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, it } from "node:test";

import { type Browser, chromium } from "playwright-core";

import { LONG_PATH, MEMORY_DAY, memoryDiff, memoryScene } from "../dev/memory.ts";

const executablePath = process.env.CHROMIUM;
if (!executablePath) throw new Error("set CHROMIUM to the path of a Chromium or Chrome");

const dist = path.join(import.meta.dirname, "../dist");
const memory = memoryScene(Date.now());

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

function stub(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/agent") return json({ name: "ペネロペ" });
    if (url.pathname === "/api/record/unseen") return json({ unseen: 0 });
    if (url.pathname === "/api/memory") return json(memory.overview);
    if (url.pathname === `/api/memory/changes/${MEMORY_DAY}`) return json(memory.changes[0]);
    if (url.pathname === `/api/memory/changes/${MEMORY_DAY}/diff`) return json(memoryDiff(url.searchParams.get("path") ?? ""));
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

}
