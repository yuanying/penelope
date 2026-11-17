import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { avatarEnv } from "../src/avatar.ts";

/** A directory of avatars with one avatar, `name`, holding its figure and its params. */
async function avatars(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "avatars-"));
  await mkdir(join(root, name));
  await writeFile(join(root, name, "appearance.yaml"), "body: x\n");
  await writeFile(join(root, name, "sdctl-params.yaml"), "steps: 1\n");
  return root;
}

const nowhere = join(tmpdir(), "no-such-avatar-dir");

test("the avatar the deployment chose is found among the avatars, and its params become sdctl's default", async () => {
  // Guards against: a figure she cannot find unless the deployment copies it, though the backend shows the same avatar's face.
  const root = await avatars("example");
  const env = avatarEnv({ PENELOPE_AVATARS_DIR: root, PENELOPE_AVATAR: "example" }, existsSync, nowhere);
  assert.deepEqual(env, { PENELOPE_AVATAR_DIR: join(root, "example"), SDCTL_PARAMS: join(root, "example", "sdctl-params.yaml") });
});

test("a figure the deployment mounted at the old place is used before the chosen avatar's", async () => {
  // Guards against: breaking a deployment that mounts its figure at /etc/penelope/avatar and sets no avatar in the sandbox.
  const old = join(await avatars("avatar"), "avatar");
  const root = await avatars("example");
  const env = avatarEnv({ PENELOPE_AVATARS_DIR: root, PENELOPE_AVATAR: "example" }, existsSync, old);
  assert.equal(env.PENELOPE_AVATAR_DIR, old);
});

test("SDCTL_PARAMS the deployment set is left as it is", async () => {
  // Guards against: taking away the deployment's own params, or the empty value with which sdctl uses none.
  const root = await avatars("example");
  const env = avatarEnv({ PENELOPE_AVATARS_DIR: root, PENELOPE_AVATAR: "example", SDCTL_PARAMS: "" }, existsSync, nowhere);
  assert.deepEqual(env, { PENELOPE_AVATAR_DIR: join(root, "example") });
});
