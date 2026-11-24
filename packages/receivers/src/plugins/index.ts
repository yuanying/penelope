// Every plugin the receivers have (ADR-0023): a plugin is added here, and the
// deployment's settings turn it on.
import type { Plugin } from "../plugin.ts";
import { alertmanager } from "./alertmanager.ts";
import { github } from "./github.ts";
import { signal } from "./signal.ts";
import { slack } from "./slack/index.ts";

export const PLUGINS: ReadonlyMap<string, Plugin> = new Map([alertmanager, github, signal, slack].map((plugin) => [plugin.name, plugin]));
