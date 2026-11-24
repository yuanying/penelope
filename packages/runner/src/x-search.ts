import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_TIMEOUT = 300;
const USAGE = `Usage: x-search '<question>' [--timeout <seconds>] (default: ${DEFAULT_TIMEOUT})`;

function fail(reason: string, code = 1) {
  console.error(`x-search: ${reason}`);
  return code;
}

function endpoint(raw: string | undefined) {
  const url = raw && URL.parse(raw);
  if (!url || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return;
  // The deployment uses HTTPS. Allow plain HTTP only on loopback for local testing.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) return;
  return new URL("/v1/responses", url);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function items(value: unknown) {
  return Array.isArray(value) ? value.map(record).filter((item) => item !== undefined) : [];
}

function postUrl(value: unknown) {
  if (typeof value !== "string") return;
  return /^https:\/\/(?:x|twitter)\.com\/(?:[a-zA-Z0-9_]+|i\/web)\/status\/[0-9]+(?=[/?#]|$)/.exec(value)?.[0];
}

function summarize(payload: Record<string, unknown>, redact: (text: string) => string) {
  const output = items(payload.output).filter((item) => item.type === "message")
    .flatMap((item) => items(item.content)).filter((part) => part.type === "output_text");
  const answer = redact(output.map((part) => typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n"))
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").trim();
  const urls = new Set(output.flatMap((part) => items(part.annotations)).flatMap((citation) => {
    const url = citation.type === "url_citation" ? postUrl(citation.url) : undefined;
    return url && url.length <= 200 ? [url] : [];
  }));
  // Both previews and the footer must fit in the default 4000-character job tail.
  const preview = answer.length > 1800 ? `${answer.slice(0, 1800).replace(/[\uD800-\uDBFF]$/, "")}\n(truncated; see Response file)` : answer;
  const citations = [...urls].slice(0, 8);
  if (urls.size > citations.length) citations.push("(more in Response file)");
  const usage = record(record(payload.usage)?.server_side_tool_usage_details);
  const count = (key: string) => typeof usage?.[key] === "number" ? usage[key] : "(not reported)";
  return [
    `Answer:\n${preview || "(none)"}`,
    `Post URLs:\n${citations.join("\n") || "(none)"}`,
    `x_posts_fetched: ${count("x_posts_fetched")}`,
    `x_users_fetched: ${count("x_users_fetched")}`,
  ].join("\n");
}

function redactJson(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redact));
  const object = record(value);
  return object ? Object.fromEntries(Object.entries(object).map(([key, item]) => [redact(key), redactJson(item, redact)])) : value;
}

async function save(payload: Record<string, unknown>, redact: (text: string) => string) {
  const dir = join(homedir(), "x-search");
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await lstat(dir)).isDirectory()) throw new Error("Not a directory");
  const name = `${randomUUID()}.json`;
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(redactJson(payload, redact), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return path.length <= 380 && !/[\x00-\x1f\x7f]/.test(path) ? path : `~/x-search/${name}`;
}

function refusal(status: number) {
  switch (status) {
    case 401: return "caller authentication was rejected; check gated and llm-proxy.";
    case 403: return "caller is not allowed; check gated and llm-proxy permissions.";
    case 502: return "the proxy could not reach its upstream.";
    case 503: return "llm-proxy may have no usable xAI login.";
    default: return "the proxy or xAI did not accept the request.";
  }
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(USAGE); return 0; }
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { timeout: { type: "string" } } });
  } catch { return fail(USAGE, 2); }
  const [question] = parsed.positionals;
  const seconds = Number(parsed.values.timeout ?? DEFAULT_TIMEOUT);
  if (parsed.positionals.length !== 1 || !question?.trim() || !Number.isInteger(seconds) || seconds < 1 || seconds > 2_147_483) {
    return fail(USAGE, 2);
  }
  const url = endpoint(process.env.X_SEARCH_URL);
  const model = process.env.X_SEARCH_MODEL?.trim();
  const token = process.env.X_SEARCH_TOKEN;
  if (!url || !model || !token || token.length < 16 || !/^[a-zA-Z0-9._~+/-]+=*$/.test(token)) {
    return fail("set X_SEARCH_URL, X_SEARCH_MODEL and X_SEARCH_TOKEN in the deployment.", 2);
  }
  const redact = (text: string) => text.replaceAll(token, "[redacted]");
  const signal = AbortSignal.timeout(seconds * 1000);
  let payload: Record<string, unknown> | undefined;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: question, tools: [{ type: "x_search" }] }),
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return fail(`HTTP ${response.status}: ${refusal(response.status)}`);
    }
    payload = record(await response.json());
  } catch (error) {
    if (signal.aborted) return fail(`timed out after ${seconds} seconds.`, 5);
    return fail(error instanceof SyntaxError ? "the response was not valid JSON." : "could not read the response from the proxy.");
  }
  if (!payload || (!Array.isArray(payload.output) && !payload.error)) {
    return fail("the proxy did not return a Responses API object.");
  }

  const path = await save(payload, redact).catch(() => undefined);
  if (!path) return fail("could not save the response under HOME.");
  console.log(redact(`${summarize(payload, redact)}\nResponse file: ${path}`));
  if (payload.error || (typeof payload.status === "string" && payload.status !== "completed")) {
    return fail("xAI did not complete the search; see the Response file.");
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2)).catch(() => fail("could not finish the search."));
