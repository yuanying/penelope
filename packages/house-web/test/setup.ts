// Runs before every test file: a DOM for the components (happy-dom), and
// JSX compiled on the way in, since Node strips types but does not read JSX.
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { transformSync } from "esbuild";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".tsx")) return nextLoad(url, context);
    const source = nextLoad(url, { ...context, format: "module" }).source;
    const { code } = transformSync(String(source), {
      loader: "tsx",
      jsx: "automatic",
      format: "esm",
      sourcefile: fileURLToPath(url),
      sourcemap: "inline",
    });
    return { format: "module", source: code, shortCircuit: true };
  },
});

GlobalRegistrator.register({ url: "http://ui.example.com/" });
// React checks this to know that updates run inside act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
