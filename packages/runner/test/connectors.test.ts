import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { listConnectors, readConnectors } from "../src/connectors.ts";

async function dir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "connectors-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  return root;
}

const doc = (name: string, description: string, hosts: string[]) =>
  `---\nname: ${name}\ndescription: ${description}\nhosts:\n${hosts.map((h) => `  - ${h}`).join("\n")}\n---\n\n# ${name}\n\nUse GH_TOKEN.\n`;

test("each <name>.md with its front matter is listed, in the order of the names", async () => {
  const root = await dir({
    "vmapi.md": doc("vmapi", "The VM API.", ["vm.example.com"]),
    "github.md": doc("github", "GitHub through gh.", ["api.github.com", "github.com"]),
  });
  const { connectors, skipped } = await readConnectors(root);
  assert.deepEqual(connectors, [
    { name: "github", description: "GitHub through gh.", hosts: ["api.github.com", "github.com"], path: join(root, "github.md") },
    { name: "vmapi", description: "The VM API.", hosts: ["vm.example.com"], path: join(root, "vmapi.md") },
  ]);
  assert.deepEqual(skipped, []);
});

test("a directory that is not there has no connectors", async () => {
  // Guards against: a session that cannot start before the deployment puts the documents in place.
  const { connectors, skipped } = await readConnectors(join(tmpdir(), "no-such-connectors-dir"));
  assert.deepEqual(connectors, []);
  assert.deepEqual(skipped, []);
});

test("a file whose front matter is missing or incomplete is left out, and said why", async () => {
  const root = await dir({
    "plain.md": "# plain\n\nno front matter\n",
    "nodesc.md": "---\nname: nodesc\nhosts: [a.example.com]\n---\n",
    "nohosts.md": "---\nname: nohosts\ndescription: d\n---\n",
    "emptyhosts.md": "---\nname: emptyhosts\ndescription: d\nhosts: []\n---\n",
    "badhost.md": "---\nname: badhost\ndescription: d\nhosts: [1]\n---\n",
    "other.md": doc("another", "Its name is not its file's.", ["a.example.com"]),
    "broken.md": "---\nname: [broken\n---\n",
    "ok.md": doc("ok", "Fine.", ["ok.example.com"]),
  });
  const { connectors, skipped } = await readConnectors(root);
  // Guards against: one broken document hiding the others, or a connector listed without what she needs to use it.
  assert.deepEqual(
    connectors.map((c) => c.name),
    ["ok"],
  );
  assert.deepEqual(skipped.map((s) => s.path).sort(), ["badhost.md", "broken.md", "emptyhosts.md", "nodesc.md", "nohosts.md", "other.md", "plain.md"].map((f) => join(root, f)));
  for (const s of skipped) assert.ok(s.reason.length > 0, s.path);
});

test("only the .md files directly in the directory are read; hidden ones and others are passed over", async () => {
  const root = await dir({ "notes.txt": "x", ".hidden.md": doc("hidden", "h", ["h.example.com"]) });
  await mkdir(join(root, "sub.md"));
  const { connectors, skipped } = await readConnectors(root);
  assert.deepEqual(connectors, []);
  assert.deepEqual(skipped, []);
});

test("a document mounted as a link, the way a ConfigMap is, is read", async () => {
  // Guards against: a runner that lists nothing from a ConfigMap, whose files are links into ..data/.
  const root = await dir({});
  await mkdir(join(root, "..data"));
  await writeFile(join(root, "..data", "github.md"), doc("github", "GitHub.", ["api.github.com"]));
  await symlink(join("..data", "github.md"), join(root, "github.md"));
  const { connectors, skipped } = await readConnectors(root);
  assert.deepEqual(
    connectors.map((c) => c.name),
    ["github"],
  );
  assert.deepEqual(skipped, []);
});

test("a connector in both the image and the deployment is listed once, with the deployment's description and hosts and both documents", async () => {
  // Guards against: a deployment that still has a full document of a connector the image has, listed twice or without its hosts.
  const image = await dir({ "slack.md": "---\nname: slack\ndescription: How slackctl is used.\n---\n" });
  const deployment = await dir({ "slack.md": doc("slack", "Slack of this deployment.", ["slack.com"]) });
  const { connectors, skipped } = await listConnectors(image, deployment);
  assert.deepEqual(connectors.list, [
    { name: "slack", description: "Slack of this deployment.", hosts: ["slack.com"], documents: [join(deployment, "slack.md"), join(image, "slack.md")] },
  ]);
  assert.deepEqual(skipped, []);
});

test("a document of the image needs no hosts, and is listed without them", async () => {
  // Guards against: the image's documents, which name no host of any deployment, being left out where the deployment has none.
  const image = await dir({ "a2a.md": "---\nname: a2a\ndescription: How the a2a CLI is used.\nhosts: [ignored.example.com]\n---\n" });
  const { connectors, skipped } = await listConnectors(image);
  assert.deepEqual(connectors, { image, list: [{ name: "a2a", description: "How the a2a CLI is used.", hosts: [], documents: [join(image, "a2a.md")] }] });
  assert.deepEqual(skipped, []);
});

test("every document the image carries is listed", async () => {
  // Guards against: a document in packages/runner/image/connectors that the runner silently leaves out of every deployment.
  const image = fileURLToPath(new URL("../image/connectors", import.meta.url));
  const { connectors, skipped } = await listConnectors(image);
  assert.deepEqual(skipped, []);
  assert.ok(connectors.list.length > 0);
});
