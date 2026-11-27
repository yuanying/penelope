import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const MIME = new Map(Object.entries({
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".map": "application/json", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
}));

/** RFC 9110, 13.1.2: `*` or a list of tags, compared without regard to `W/`. */
function namesIt(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === "*") return true;
  return (header.match(/(?:W\/)?"[^"]*"/g) ?? []).some((tag) => tag.replace(/^W\//, "") === etag);
}

export async function serveWeb(dir: string, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const name = path === "/" ? "/index.html" : path;
  if (!/^(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)+$/.test(name)) return false;
  const contentType = MIME.get(extname(name));
  if (!contentType) return false;
  try {
    const root = await realpath(dir);
    const file = await realpath(resolve(root, `.${name}`));
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) return false;
    const content = await readFile(file);
    const etag = `"${createHash("sha256").update(content).digest("base64url")}"`;
    const headers = {
      etag,
      "cache-control": name.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    };
    if (namesIt(request.headers["if-none-match"], etag)) {
      response.writeHead(304, headers).end();
      return true;
    }
    response.writeHead(200, { ...headers, "content-type": contentType, "content-length": content.length })
      .end(request.method === "HEAD" ? undefined : content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw error;
  }
}
