import type { Readable } from "node:stream";
import { createInterface } from "node:readline";

/** Retain the JSONL line and all of its text, but not serialized Pi image data. */
function withoutImages(line: string): string {
  // Most records contain no images. Parse only when there could be image data.
  if (!line.includes('"image"')) return line;
  try {
    let omitted = false;
    const record = JSON.parse(line, (_key, value) => {
      if (value?.type === "image" && typeof value.data === "string") {
        omitted = true;
        return { ...value, data: "[image data omitted]" };
      }
      return value;
    });
    return omitted ? JSON.stringify(record) : line;
  } catch {
    return line;
  }
}

export async function* textLines(input: Readable, jsonl: boolean): AsyncGenerator<[number, string]> {
  const reader = createInterface({ input, crlfDelay: Infinity });
  let number = 0;
  try {
    for await (const line of reader) yield [++number, jsonl ? withoutImages(line) : line];
  } finally {
    reader.close();
  }
}

/** A long line can span pages without losing any text or splitting a Unicode character. */
export async function textPage(lines: AsyncIterable<[number, string]>, offset: number, column: number, limit: number): Promise<string> {
  const output: string[] = [];
  let remaining = 8_000;
  const continued = (line: number, col: number) => `${output.join("\n")}\n\n[Continue with offset=${line}, column=${col}]`;
  for await (const [number, line] of lines) {
    if (number < offset) continue;
    if (number >= offset + limit || remaining < 2) return continued(number, 1);
    const start = number === offset ? column - 1 : 0;
    if (start > line.length) throw new Error(`Column ${column} is beyond line ${number}.`);
    let end = Math.min(line.length, start + remaining);
    if (end < line.length && line.codePointAt(end - 1)! > 0xffff) end--;
    output.push(line.slice(start, end));
    if (end < line.length) return continued(number, end + 1);
    remaining -= end - start + 1;
  }
  if (output.length === 0 && (offset !== 1 || column !== 1)) throw new Error(`Offset ${offset}, column ${column} is beyond end of file.`);
  return output.join("\n");
}
