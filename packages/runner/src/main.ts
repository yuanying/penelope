// The runner runs the session with Pi's SDK inside the sandbox, taking the
// events from the backend one turn at a time (ADR-0001, ADR-0002).
//
//   runner run      run until SIGTERM or SIGINT
//   runner version  print the version
import process from "node:process";

import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { Backend } from "./backend.ts";
import { ConfigError, readConfig } from "./config.ts";
import { houseConnection } from "./house.ts";
import { readImageLimits } from "./image-limit.ts";
import { Runner } from "./runner.ts";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

const USAGE = "usage: runner run | runner version\n";

// The version is given by the image (the Dockerfile's VERSION build argument).
export function run(args: readonly string[], env: Readonly<Record<string, string | undefined>>): Result {
  if (args.length === 1 && args[0] === "version") {
    return { code: 0, stdout: `${env.PENELOPE_VERSION ?? "dev"}\n`, stderr: "" };
  }
  return { code: 2, stdout: "", stderr: USAGE };
}

/** `runner run`: Pi's directory holds the models, the credentials and the settings, as Pi has them. */
async function serve(env: Readonly<Record<string, string | undefined>>): Promise<number> {
  let config;
  try {
    config = readConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`runner: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const modelsPath = `${config.agentDir}/models.json`;
  const imageLimits = await readImageLimits(modelsPath);
  const modelRuntime = await ModelRuntime.create({
    authPath: `${config.agentDir}/auth.json`,
    modelsPath,
  });
  const house = houseConnection(env);
  if (!house && (env.HOUSE_URL !== undefined || env.HOUSE_TOKEN !== undefined)) {
    process.stderr.write("runner: invalid house settings; set HOUSE_URL and HOUSE_TOKEN together to enable house replies\n");
  }
  const runner = new Runner({
    config,
    ...(house ? { house } : {}),
    backend: new Backend({ url: config.backend.url, token: config.backend.token, agent: config.agent }),
    modelRuntime,
    imageLimits,
    settings: () => SettingsManager.create(config.home, config.agentDir),
  });
  const controller = new AbortController();
  for (const name of ["SIGTERM", "SIGINT"] as const) process.once(name, () => controller.abort());
  await runner.run(controller.signal);
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "run") {
    process.exitCode = await serve(process.env);
  } else {
    const result = run(args, process.env);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
  }
}
