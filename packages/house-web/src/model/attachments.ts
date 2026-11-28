import { REPLY_IMAGE_MAX_BYTES, REPLY_IMAGE_TYPES, type ReplyImageUpload } from "@penelope/contract";

type Mime = typeof REPLY_IMAGE_TYPES[number];
type ImageCheck = { kind: "checking" } | { kind: "ready"; mime: Mime } | { kind: "invalid"; reason: "size" | "name" | "format" | "read" };

export type Attachment = { id: number; file: File } & ImageCheck;

export async function checkImage(file: File): Promise<ImageCheck> {
  if (file.size > REPLY_IMAGE_MAX_BYTES) return { kind: "invalid", reason: "size" };
  const { name } = file;
  if (name.trim() === "" || name.length > 255 || name === "." || name === ".." || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    return { kind: "invalid", reason: "name" };
  }
  try {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
    const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: "ready", mime: "image/png" };
    if (starts(0xff, 0xd8, 0xff)) return { kind: "ready", mime: "image/jpeg" };
    if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return { kind: "ready", mime: "image/gif" };
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { kind: "ready", mime: "image/webp" };
    return { kind: "invalid", reason: "format" };
  } catch {
    return { kind: "invalid", reason: "read" };
  }
}

export function encodeImage(file: File): Promise<ReplyImageUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(",", 2)[1]! });
    reader.readAsDataURL(file);
  });
}
