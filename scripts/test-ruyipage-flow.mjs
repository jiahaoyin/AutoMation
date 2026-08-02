import { spawnSync } from "node:child_process";

import { resolvePythonCommand } from "./lib/ruyipage-runtime.js";

const python = resolvePythonCommand();
if (!python) {
  console.error("Python 3.10+ is required to run the ruyiPage flow tests.");
  process.exit(1);
}

const result = spawnSync(
  python,
  ["-m", "unittest", "scripts/ruyipage/test_apple_account_flow.py"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
    },
  }
);

process.exit(result.status ?? 1);
