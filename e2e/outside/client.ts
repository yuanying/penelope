// The owner's browser, outside the Pod: the test runs this in the outside
// container to reach the backend's API for the UI and the fakes' control API,
// so that it needs no port published to the machine it runs on.
//
//   client.ts request <url> <method> [<headers as JSON>]   body on stdin
//       prints {status, headers, body} as one JSON line
import process from "node:process";

const [mode, url, third] = process.argv.slice(2);

async function stdin(): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of process.stdin) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

if (mode === "request" && url) {
  const method = third ?? "GET";
  const headers = JSON.parse(process.argv[5] ?? "{}") as Record<string, string>;
  const body = method === "GET" ? undefined : new Uint8Array(await stdin());
  const response = await fetch(url, { method, headers, body, redirect: "manual" });
  process.stdout.write(
    `${JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })}\n`,
  );
} else {
  process.stderr.write("usage: client.ts request <url> <method> [<headers>]\n");
  process.exitCode = 2;
}
