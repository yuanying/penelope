import { readFile, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const MIME = new Map(Object.entries({
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
}));

export async function serveWeb(dir: string, path: string, head: boolean, response: ServerResponse): Promise<boolean> {
  const name = path === "/" ? "/index.html" : path;
  if (!/^(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)+$/.test(name)) return false;
  const contentType = MIME.get(extname(name));
  if (!contentType) return false;
  try {
    const root = await realpath(dir);
    const file = await realpath(resolve(root, `.${name}`));
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) return false;
    const content = await readFile(file);
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": content.length,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    }).end(head ? undefined : content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw error;
  }
}
