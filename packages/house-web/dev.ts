// The house's screen over the real house server with made-up residents
// (dev/house.ts): `npm run dev`, then open the address it prints. It builds
// again when src/ or public/ changes and tells the open pages to reload.
import { watch } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import type { HouseConversationDelivery } from "@penelope/contract";

import { buildUi } from "./build.ts";
import { type AgentId, EVENING_BEHIND_MS, type FakeHouse, PEOPLE, playEvening, startFakeHouse } from "./dev/house.ts";

const here = import.meta.dirname;
const dist = path.join(here, "dist");
const port = Number(process.env.PORT ?? 5174);
const reloadPort = port + 1;

async function rebuild(): Promise<boolean> {
  const started = Date.now();
  try {
    await buildUi(dist, { minify: false, nodeEnv: "development" });
  } catch (error) {
    // esbuild has printed what is wrong; the pages keep what they have.
    console.error(`build failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return false;
  }
  console.log(`built in ${Date.now() - started} ms`);
  return true;
}

await rebuild();

// The house serves every path of its own port, so the pages listen for the reload on the next port.
const pages = new Set<import("node:http").ServerResponse>();
createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" });
  response.write(":\n\n");
  pages.add(response);
  request.on("close", () => pages.delete(response));
}).listen(reloadPort, "127.0.0.1");

// Saving a file often writes it more than once: build once for the lot.
let pending: NodeJS.Timeout | undefined;
let building = Promise.resolve();
for (const dir of ["src", "public"]) {
  watch(path.join(here, dir), { recursive: true }, () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      building = building.then(async () => {
        if (await rebuild()) for (const page of pages) page.write("event: reload\ndata: \n\n");
      });
    }, 100);
  });
}

const LINES: Record<AgentId, string[]> = {
  penelope: ["うん、聞いているよ", "そうだね。今日は静かでいい夜だよ", "あとで日記に書いておくね"],
  natsumi: ["はい、わかりました", "それ、予定に入れておくね"],
  aki: ["ふーん、そうなんだ", "まだ少し眠い……"],
  myao: ["にゃるほどね", "それ、あたしも気になってた"],
  sayaka: ["うん、いいと思う", "あとで詳しく聞かせて"],
};
const GREETINGS: Record<AgentId, string> = { penelope: "おかえりなさい", natsumi: "あ、こんばんは", aki: "ん、来たんだ", myao: "わっ、びっくりした", sayaka: "おかえり" };
let line = 0;

/** An awake resident answers a person who addressed them, and greets one who came in. */
function answer(agent: AgentId, { event, answer_via }: HouseConversationDelivery, house: FakeHouse): void {
  if (event.actor.kind !== "person" || house.statusOf(agent)?.sleep.state !== "awake") return;
  const words = event.kind === "enter" ? GREETINGS[agent] : event.kind === "speech" && answer_via ? LINES[agent][line++ % LINES[agent].length]! : undefined;
  if (words === undefined) return;
  setTimeout(() => void house.agent(agent).reply({ text: words, expression: "happy", to: [event.actor.id] }).catch(() => {}), 1_200);
}

const house = await startFakeHouse({
  webDir: dist,
  port,
  behindMs: EVENING_BEHIND_MS,
  pageTail: `<script>new EventSource("http://127.0.0.1:${reloadPort}/").addEventListener("reload", () => location.reload());</script>`,
  onDelivery: answer,
});
await playEvening(house, { long: true });

console.log(`\nThe house's screen over a made-up house: ${house.origin}/\n\nSign in as (the screen's own button signs in as the first):`);
for (const person of PEOPLE) console.log(`  ${person.name.padEnd(6)} ${house.origin}/auth/github/start?as=${person.login}`);
console.log("\nAddress a resident with @ or send a direct message to Sayaka. Sleeping residents receive only direct messages after waking.\n");
