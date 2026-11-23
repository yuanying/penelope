import { posix } from "node:path";

import { parse, postprocess, preprocess } from "micromark";
import { decodeString } from "micromark-util-decode-string";
import { normalizeIdentifier } from "micromark-util-normalize-identifier";

import { memoryPath } from "./memory-git.ts";

export type LocalLink = { line: number; destination: string; target: string };
type Link = { line: number; label?: string; reference?: string; destination?: string };

/** Actual CommonMark link/image uses, including references, not code samples or unused definitions. */
export function localLinks(path: string, text: string): LocalLink[] {
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  const definitions = new Map<string, string>();
  let definition: { label?: string; destination?: string } = {};
  const uses: Link[] = [];
  const open: Link[] = [];
  for (const [event, token, context] of postprocess(parse().document().write(preprocess()(text, undefined, true)))) {
    const { type, start, end } = token;
    if (type === "link" || type === "image") {
      if (event === "enter") {
        const link = { line: start.line };
        uses.push(link);
        open.push(link);
      } else open.pop();
    } else if (type === "definition" && event === "exit") {
      const label = normalizeIdentifier(definition.label ?? "");
      if (!definitions.has(label)) definitions.set(label, definition.destination ?? "");
      definition = {};
    } else if (event === "enter") {
      const raw = () => text.slice(start.offset, end.offset);
      if (type === "definitionLabelString") definition.label = context.sliceSerialize(token);
      else if (type === "definitionDestinationString") definition.destination = raw();
      else {
        const link = open.at(-1);
        if (!link) continue;
        if (type === "labelText") link.label = context.sliceSerialize(token);
        else if (type === "referenceString") link.reference = context.sliceSerialize(token);
        else if (type === "resource") link.destination = "";
        else if (type === "resourceDestinationString") link.destination = raw();
      }
    }
  }
  return uses.flatMap(({ line, label, reference, destination }) => {
    const raw = destination ?? definitions.get(normalizeIdentifier(reference ?? label ?? ""));
    if (!raw) return [];
    const decoded = decodeString(raw).split(/[?#]/, 1)[0]!;
    if (!decoded || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(decoded)) return [];
    try {
      const relative = decodeURIComponent(decoded);
      if (relative.startsWith("/")) return [];
      const target = posix.join(posix.dirname(path), relative).replace(/\/$/, "");
      return target === "." || memoryPath(target) ? [{ line, destination: raw, target }] : [];
    } catch { return []; }
  });
}
