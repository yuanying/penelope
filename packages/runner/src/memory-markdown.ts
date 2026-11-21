import { dirname, isAbsolute, resolve } from "node:path";

import { parse, postprocess, preprocess } from "micromark";
import { decodeString } from "micromark-util-decode-string";

import { memoryPath } from "./memory-reads.ts";

/** Source spans refer to `text`: Micromark skips a leading BOM in its offsets. */
export function memoryMarkdown(body: string) {
  const text = body.startsWith("\uFEFF") ? body.slice(1) : body;
  const events = postprocess(parse().document().write(preprocess()(text, undefined, true)));
  return { text, events };
}

/** Preserve the raw query/fragment, including Markdown escapes or character references. */
function splitDestination(raw: string): [path: string, suffix: string] {
  for (const match of raw.matchAll(/\\[\\?#]|&(?:#[\da-z]+|[a-z][\da-z]*);|[?#]/gi)) {
    if (/^[?#]$/.test(decodeString(match[0]))) return [raw.slice(0, match.index), raw.slice(match.index)];
  }
  return [raw, ""];
}

export function memoryLink(root: string, source: string, raw: string): {
  path: string; suffix: string; prefix: string | undefined; target: string | undefined;
} | undefined {
  const [rawPath, suffix] = splitDestination(raw);
  const decoded = decodeString(rawPath);
  if (!decoded || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(decoded)) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(decoded);
  } catch {
    return undefined;
  }
  const prefix = isAbsolute(path) ? [root, "/memory"].find((candidate) => path.startsWith(`${candidate}/`)) : undefined;
  if (isAbsolute(path) && prefix === undefined) return undefined;
  const target = memoryPath(root, prefix === undefined
    ? resolve(root, dirname(source), path) : resolve(root, path.slice(prefix.length + 1)));
  return { path, suffix, prefix, target };
}
