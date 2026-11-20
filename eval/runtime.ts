import { stat } from "node:fs/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function createPiRuntime(authPath: string, ref: { provider: string; id: string }): Promise<ModelRuntime> {
  const file = await stat(authPath).catch(() => undefined);
  if (!file?.isFile()) throw new Error("EVAL_PI_AUTH must point to an existing Pi auth file");

  // Only auth is shared. Pi locks this file for reads and OAuth refreshes;
  // neither the model catalog cache nor any other agentDir resource is needed.
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false })
    .catch(() => { throw new Error("Could not initialize the Pi model runtime"); });
  if (!runtime.getModel(ref.provider, ref.id)) {
    throw new Error(`Model ${ref.provider}/${ref.id} is not in this ref's built-in Pi catalog`);
  }
  const credentials = await runtime.listCredentials()
    .catch(() => { throw new Error("Could not read Pi credentials from EVAL_PI_AUTH"); });
  if (!runtime.getProvider(ref.provider)?.auth.oauth ||
    !credentials.some((entry) => entry.providerId === ref.provider && entry.type === "oauth")) {
    throw new Error(`No Pi OAuth login for ${ref.provider} (check EVAL_PI_AUTH and write access for Pi's lock)`);
  }
  return runtime;
}
