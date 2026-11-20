import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPiRuntime } from "./runtime.ts";

test("Pi OAuth refresh writes the rotated login back to the supplied file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "night-eval-auth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify({ openai: {
    type: "oauth", access: "old-example", refresh: "old-refresh-example", expires: 0, clientId: "example",
  } }));
  t.mock.method(globalThis, "fetch", async () => Response.json({
    access_token: "new-example", refresh_token: "new-refresh-example", expires_in: 3600, scope: "chatgpt.tokens.use.direct",
  }));

  const ref = { provider: "openai", id: "gpt-6.1-sol" };
  const runtime = await createPiRuntime(authPath, ref);
  await runtime.getAuth(ref.provider);

  assert.equal(JSON.parse(await readFile(authPath, "utf8")).openai.refresh, "new-refresh-example");
});
