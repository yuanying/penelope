// What is under assets/ is named by its content, so that the house can let
// it be kept for good (docs/house.md, 静的ファイル).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";

const here = import.meta.dirname;

/** The development server skips the minifying and keeps React's warnings. */
export type BuildOptions = { minify: boolean; nodeEnv: "production" | "development" };

export async function buildUi(dist: string, { minify, nodeEnv }: BuildOptions): Promise<void> {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  const result = await build({
    entryPoints: [path.join(here, "src/main.tsx")],
    conditions: ["penelope-source", "module"],
    bundle: true,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    minify,
    sourcemap: true,
    outdir: path.join(dist, "assets"),
    entryNames: "app-[hash]",
    assetNames: "[name]-[hash]",
    loader: { ".woff": "file", ".woff2": "file", ".svg": "file", ".png": "file" },
    define: { "process.env.NODE_ENV": JSON.stringify(nodeEnv) },
    metafile: true,
    logLevel: "warning",
  });

  const outputs = Object.keys(result.metafile.outputs).map((file) => path.basename(file));
  const js = outputs.find((file) => file.startsWith("app-") && file.endsWith(".js"));
  const css = outputs.find((file) => file.startsWith("app-") && file.endsWith(".css"));
  if (!js || !css) throw new Error(`the build made no script or no styles: ${outputs.join(", ")}`);

  const page = readFileSync(path.join(here, "public/index.html"), "utf8").replace("{{js}}", js).replace("{{css}}", css);
  writeFileSync(path.join(dist, "index.html"), page);
  copyFileSync(path.join(here, "public/icon.svg"), path.join(dist, "icon.svg"));
}

if (import.meta.main) await buildUi(path.join(here, "dist"), { minify: true, nodeEnv: "production" });
