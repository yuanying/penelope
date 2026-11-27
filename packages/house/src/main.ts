import { readFileSync } from "node:fs";

import { parseConfig } from "./config.ts";
import { startHouse } from "./server.ts";

try {
  const file = process.env.PENELOPE_HOUSE_CONFIG_FILE ?? "/etc/penelope/house.json";
  const config = parseConfig(JSON.parse(readFileSync(file, "utf8")) as unknown);
  const house = await startHouse(config);
  console.error(`house: listening on ${config.listen.host}:${house.port}`);
  async function stop() {
    try {
      await house.close();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
} catch (error) {
  console.error(`house: ${error instanceof SyntaxError ? "the config is not valid JSON" : error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
