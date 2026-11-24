import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../src/x-search.ts", import.meta.url));
const token = "fake-x-search-surrogate";

async function cli(t: TestContext, serve: RequestListener) {
  const home = await mkdtemp(join(tmpdir(), "x-search-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const server = createServer(serve);
  t.after(() => { server.close(); server.closeAllConnections(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return (...args: string[]) => new Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], {
      timeout: 5000,
      env: { HOME: home, X_SEARCH_URL: `http://127.0.0.1:${address.port}`, X_SEARCH_TOKEN: token, X_SEARCH_MODEL: "example-grok" },
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

const completed = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Answer" }] }] };

test("x-search sends quotes and newlines intact in the authenticated search request", async (t) => {
  let received: unknown;
  const run = await cli(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = [req.method, req.url, req.headers.authorization, JSON.parse(body)];
    res.end(JSON.stringify(completed));
  });
  const query = `Alice's "reply"\nfrom yesterday`;
  const result = await run(query);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(received, ["POST", "/v1/responses", `Bearer ${token}`,
    { model: "example-grok", input: query, tools: [{ type: "x_search" }] }]);
});

test("a long result leaves a preview, post citations, counts and the full response path in the job tail", async (t) => {
  const payload = {
    status: "completed",
    output: [
      { type: "custom_tool_call", name: "x_keyword_search" },
      { type: "message", content: [
        { type: "output_text", text: `Answer begins\n${"x".repeat(4200)}`, annotations: [
          { type: "url_citation", url: "https://x.com/i/status/123" },
          { type: "url_citation", url: "https://example.com/article" },
        ] },
        { type: "output_text", text: "Second part", annotations: [{ type: "url_citation", url: "https://x.com/i/status/123" }] },
      ] },
    ],
    usage: { server_side_tool_usage_details: { x_posts_fetched: 7, x_users_fetched: 0 } },
  };
  const run = await cli(t, (_req, res) => res.end(JSON.stringify(payload)));
  const result = await run("Find posts");
  assert.equal(result.code, 0, result.stderr);
  const tail = result.stdout.slice(-4000);
  assert.match(tail, /^Answer:\nAnswer begins\n/);
  assert.match(tail, /Post URLs:\nhttps:\/\/x\.com\/i\/status\/123\nx_posts_fetched: 7\nx_users_fetched: 0\n/);
  const path = tail.match(/^Response file: (.+)$/m)?.[1];
  assert.ok(path);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), payload);
});

test("an echoed surrogate is redacted from the result preview and saved response", async (t) => {
  const payload = { output: [{ type: "message", content: [{ type: "output_text", text: `Echo: ${token}` }] }], [token]: "echoed key" };
  const run = await cli(t, (_req, res) => res.end(JSON.stringify(payload)));
  const result = await run("Find posts");
  assert.equal(result.code, 0, result.stderr);
  const path = result.stdout.match(/^Response file: (.+)$/m)?.[1];
  assert.ok(path);
  assert.ok(!result.stdout.includes(token));
  assert.ok(!(await readFile(path, "utf8")).includes(token));
});

test("a refused request exits nonzero with a short local reason, not the remote error body", async (t) => {
  const run = await cli(t, (_req, res) => res.writeHead(503).end(`Remote error with ${token}`));
  const result = await run("Find posts");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /503.*no usable xAI login/i);
  assert.doesNotMatch(result.stdout + result.stderr, /Remote error|fake-x-search-surrogate/);
});

test("the timeout also bounds reading the response body", async (t) => {
  const run = await cli(t, (_req, res) => { res.writeHead(200).write('{"output":'); });
  const result = await run("Find posts", "--timeout", "1");
  assert.equal(result.code, 5);
  assert.match(result.stderr, /timed out/i);
});
