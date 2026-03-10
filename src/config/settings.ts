import { join } from "node:path";
import { homedir } from "node:os";

export interface OptimizerSettings {
  dataDir: string;
  dbPath: string;
  currentPlan: {
    codex: "plus" | "pro" | "api";
    claude: "pro" | "max_100" | "max_200" | "api";
    zai: "lite" | "pro" | "api";
  };
}

const DATA_DIR = join(homedir(), ".optimizer-mcp");

export function getSettings(): OptimizerSettings {
  return {
    dataDir: DATA_DIR,
    dbPath: join(DATA_DIR, "usage.db"),
    currentPlan: {
      codex: "plus",
      claude: "pro",
      zai: "lite",
    },
  };
}
