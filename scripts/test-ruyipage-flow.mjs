import { spawnSync } from "node:child_process";
import path from "node:path";

import { resolvePythonCommand } from "./lib/ruyipage-runtime.js";

const python = resolvePythonCommand();
if (!python) {
  console.error("Python 3.10+ is required to run the ruyiPage flow tests.");
  process.exit(1);
}

const pathKey = process.platform === "win32" ? "Path" : "PATH";
const childEnv = {
  ...process.env,
  PYTHONDONTWRITEBYTECODE: "1",
};
childEnv[pathKey] = [path.dirname(process.execPath), childEnv[pathKey]]
  .filter(Boolean)
  .join(path.delimiter);

const result = spawnSync(
  python,
  ["-m", "unittest", "scripts/ruyipage/test_apple_account_flow.py"],
  {
    stdio: "inherit",
    env: childEnv,
  }
);

process.exit(result.status ?? 1);
