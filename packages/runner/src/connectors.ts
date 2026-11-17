// The connectors' documents (ADR-0020, ADR-0035, docs/sentinel-config.md
// "コネクタの文書"). The image carries one <name>.md for each tool it knows the
// use of, and the deployment puts one for each connector it registered into
// a directory of its own. The runner lists their front matter in her system
// prompt, one entry a name, and she reads the rest when she needs it.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface Connector {
  name: string;
  description: string;
  /** The names of the Sentinel's registrations it uses. */
  hosts: string[];
  /** Its document. */
  path: string;
}

/** One entry of the list: a name, from the image, the deployment or both. */
export interface Listed {
  name: string;
  /** The deployment's, when it has the name. */
  description: string;
  /** The deployment's; none when only the image has the name. */
  hosts: string[];
  /** The deployment's document first, then the image's. */
  documents: string[];
}

/** What the system prompt lists: the places, and the connectors by name. */
export interface ConnectorList {
  image: string;
  /** Left out when the deployment gave no directory. */
  deployment?: string;
  list: Listed[];
}

export interface Skipped {
  path: string;
  reason: string;
}

/**
 * The image's documents and the deployment's, one entry a name, in the order
 * of the names. A name in both is the deployment's, with both documents.
 */
export async function listConnectors(image: string, deployment?: string): Promise<{ connectors: ConnectorList; skipped: Skipped[] }> {
  const ofImage = await readConnectors(image, { hosts: false });
  const ofDeployment = deployment ? await readConnectors(deployment) : { connectors: [], skipped: [] };
  const byName = new Map<string, Listed>();
  for (const c of ofImage.connectors) byName.set(c.name, { name: c.name, description: c.description, hosts: [], documents: [c.path] });
  for (const c of ofDeployment.connectors) {
    const fromImage = byName.get(c.name)?.documents ?? [];
    byName.set(c.name, { name: c.name, description: c.description, hosts: c.hosts, documents: [c.path, ...fromImage] });
  }
  const list = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    connectors: { image, ...(deployment ? { deployment } : {}), list },
    skipped: [...ofImage.skipped, ...ofDeployment.skipped],
  };
}

/**
 * The connectors in `dir`, by name. A directory that is not there has none.
 * The image's documents name no hosts, so `hosts: false` reads none.
 */
export async function readConnectors(dir: string, options: { hosts: boolean } = { hosts: true }): Promise<{ connectors: Connector[]; skipped: Skipped[] }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { connectors: [], skipped: [] };
  }
  const connectors: Connector[] = [];
  const skipped: Skipped[] = [];
  for (const file of names.sort()) {
    if (file.startsWith(".") || !file.endsWith(".md")) continue;
    const path = join(dir, file);
    try {
      if (!(await stat(path)).isFile()) continue;
    } catch {
      continue;
    }
    const read = await connector(path, file.slice(0, -".md".length), options.hosts);
    if ("reason" in read) skipped.push(read);
    else connectors.push(read);
  }
  return { connectors, skipped };
}

async function connector(path: string, expected: string, withHosts: boolean): Promise<Connector | Skipped> {
  let frontmatter: Record<string, unknown>;
  try {
    ({ frontmatter } = parseFrontmatter<Record<string, unknown>>(await readFile(path, "utf8")));
  } catch (error) {
    return { path, reason: `cannot be read: ${(error as Error).message}` };
  }
  const { name, description, hosts } = frontmatter;
  if (typeof name !== "string" || name === "") return { path, reason: "has no name in its front matter" };
  if (name !== expected) return { path, reason: `is named ${name}, not ${expected} as its file is` };
  if (typeof description !== "string" || description.trim() === "") return { path, reason: "has no description in its front matter" };
  if (!withHosts) return { name, description: description.trim(), hosts: [], path };
  if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every((host) => typeof host === "string" && host !== "")) {
    return { path, reason: "has no hosts, a list of host names, in its front matter" };
  }
  return { name, description: description.trim(), hosts, path };
}
