// Where her figure is (ADR-0035, docs/pod.md "姿の素材"). The avatar the
// deployment chose with PENELOPE_AVATAR is a directory under
// PENELOPE_AVATARS_DIR, as the backend reads it, and the image carries the
// repository's avatars. A figure mounted at /etc/penelope/avatar, the place
// deployments used before, comes first. The shell is told the directory as
// PENELOPE_AVATAR_DIR, and sdctl its params as SDCTL_PARAMS when the
// deployment set none.

import { join } from "node:path";

/** Where the sandbox's image carries the repository's assets/avatars (Dockerfile). */
export const IMAGE_AVATARS_DIR = "/opt/penelope/avatars";
/** Where deployments mounted the figure before the avatars carried it. */
export const MOUNTED_AVATAR_DIR = "/etc/penelope/avatar";

const NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** The variables to add to the runner's environment for the figure; none when there is no figure. */
export function avatarEnv(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean,
  mounted = MOUNTED_AVATAR_DIR,
): Record<string, string> {
  const chosen = env.PENELOPE_AVATAR && NAME.test(env.PENELOPE_AVATAR) ? join(env.PENELOPE_AVATARS_DIR || IMAGE_AVATARS_DIR, env.PENELOPE_AVATAR) : undefined;
  const dir = exists(join(mounted, "appearance.yaml")) ? mounted : chosen;
  if (!dir || !exists(dir)) return {};
  const params = join(dir, "sdctl-params.yaml");
  return { PENELOPE_AVATAR_DIR: dir, ...(env.SDCTL_PARAMS === undefined && exists(params) ? { SDCTL_PARAMS: params } : {}) };
}
