import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_LOCK_NAME } from "./constants.js";

export async function acquireLock(codexHome, label = "codex-provider-sync") {
  const lockDir = path.join(codexHome, "tmp", DEFAULT_LOCK_NAME);
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new Error(`Lock already exists at ${lockDir}. Close Codex/App and retry, or remove the stale lock if you are sure no sync is running.`);
    }
    throw error;
  }

  const ownerPath = path.join(lockDir, "owner.json");
  const owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    label,
    cwd: process.cwd()
  };
  await fs.writeFile(ownerPath, JSON.stringify(owner, null, 2), "utf8");

  let released = false;
  return async function releaseLock() {
    if (released) {
      return;
    }
    released = true;
    await fs.rm(lockDir, { recursive: true, force: true });
  };
}
