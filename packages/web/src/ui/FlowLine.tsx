import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { type ReactNode, useState } from "react";

import type { RecordFlowItem } from "@penelope/contract";

import { Linked } from "./links.tsx";
import { words } from "./words.ts";

export function FlowLine({ item, result }: {
  item: RecordFlowItem;
  result: (call: Extract<RecordFlowItem, { kind: "tool_call" }>) => ReactNode;
}) {
  switch (item.kind) {
    case "thinking":
    case "message":
      return (
        <li className="flow-block">
          <span className="flow-label">{item.kind === "thinking" ? words.thought : words.message}</span>
          <Folded text={item.text} />
        </li>
      );
    case "tool_call": {
      const what = argumentsText(item.arguments);
      return (
        <li className="flow-block">
          <span className="flow-tool">
            <span className="flow-label">{words.tool}</span>
            <Code><strong>{item.name}</strong>{what !== "" && <>: <Linked text={what} /></>}</Code>
          </span>
          {result(item)}
        </li>
      );
    }
    case "tool_result":
      return null;
  }
}

function Folded({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className={open ? "folded open" : "folded"}><Linked text={text} /></p>
      <Button label={open ? words.thoughtClose : words.thoughtOpen} variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open} />
    </>
  );
}

function argumentsText(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === null || args === undefined) return "";
  if (typeof args !== "object" || Array.isArray(args)) return JSON.stringify(args) ?? "";
  const record = args as Record<string, unknown>;
  const str = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : undefined);
  const command = str("command");
  if (command !== undefined) return command;
  const pattern = str("pattern");
  const path = str("path");
  if (pattern !== undefined) return path !== undefined ? `${pattern} in ${path}` : pattern;
  if (path !== undefined) return path;
  const values = Object.values(record);
  if (values.length === 0) return "";
  const strings = values.filter((value): value is string => typeof value === "string");
  if (strings.length === 1) return strings[0]!;
  return JSON.stringify(args);
}
