import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { acquireLock } from "./locking.js";
import {
  applyPullBundle,
  buildUploadBundle,
  listLocalCloudSessions
} from "./cloud-local.js";
import { defaultCodexHome } from "./constants.js";

function normalizeCodexHome(explicitCodexHome) {
  return path.resolve(explicitCodexHome ?? process.env.CODEX_HOME ?? defaultCodexHome());
}

function cloudConfigPath(codexHome) {
  return path.join(codexHome, "cloud-sync.json");
}

function normalizeServer(server) {
  if (!server) {
    throw new Error("Missing cloud server URL.");
  }
  return String(server).replace(/\/+$/, "");
}

async function readCloudConfig(codexHome) {
  try {
    return JSON.parse(await fs.readFile(cloudConfigPath(codexHome), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeCloudConfig(codexHome, config) {
  await fs.mkdir(codexHome, { recursive: true });
  const configPath = cloudConfigPath(codexHome);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  try {
    await fs.chmod(configPath, 0o600);
  } catch {
    // Best effort on platforms that support POSIX permissions.
  }
}

function makeDevice(existing = {}) {
  return {
    id: existing.device?.id ?? crypto.randomUUID(),
    name: existing.device?.name ?? os.hostname(),
    platform: process.platform,
    hostname: os.hostname()
  };
}

async function cloudRequest(config, apiPath, { method = "GET", body, token = config.token } = {}) {
  const response = await fetch(`${normalizeServer(config.server)}${apiPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : { error: await response.text() };
  if (!response.ok) {
    throw new Error(data?.error || `Cloud request failed with HTTP ${response.status}`);
  }
  return data;
}

async function requireCloudConfig(codexHome) {
  const config = await readCloudConfig(codexHome);
  if (!config?.server || !config?.token) {
    throw new Error("Cloud sync is not logged in. Run codex-provider cloud-login first.");
  }
  return config;
}

export async function getCloudClientStatus({ codexHome: explicitCodexHome } = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  const config = await readCloudConfig(codexHome);
  return {
    codexHome,
    loggedIn: Boolean(config?.server && config?.token),
    server: config?.server ?? null,
    username: config?.username ?? null,
    device: config?.device ?? null
  };
}

export async function runCloudLogin({
  codexHome: explicitCodexHome,
  server,
  username = "admin",
  password,
  deviceName
} = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  const existing = await readCloudConfig(codexHome) ?? {};
  const device = {
    ...makeDevice(existing),
    ...(deviceName ? { name: deviceName } : {})
  };
  const resolvedPassword = password ?? process.env.CODEX_SYNC_PASSWORD;
  if (!resolvedPassword) {
    throw new Error("Missing password. Pass --password or set CODEX_SYNC_PASSWORD.");
  }

  const result = await cloudRequest(
    { server },
    "/api/login",
    {
      method: "POST",
      token: null,
      body: {
        username,
        password: resolvedPassword,
        device
      }
    }
  );
  const config = {
    version: 1,
    server: normalizeServer(server),
    token: result.token,
    username: result.user?.username ?? username,
    device,
    loggedInAt: new Date().toISOString()
  };
  await writeCloudConfig(codexHome, config);
  return {
    codexHome,
    server: config.server,
    username: config.username,
    device
  };
}

export async function listCloudLocalSessions({ codexHome: explicitCodexHome } = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  return await listLocalCloudSessions(codexHome);
}

export async function listCloudRemoteSessions({ codexHome: explicitCodexHome } = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  const config = await requireCloudConfig(codexHome);
  const result = await cloudRequest(config, "/api/remote-sessions");
  return {
    codexHome,
    server: config.server,
    sessions: result.sessions ?? []
  };
}

export async function runCloudPush({
  codexHome: explicitCodexHome,
  ids,
  all = false
} = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  const config = await requireCloudConfig(codexHome);
  const bundle = await buildUploadBundle(codexHome, {
    ids,
    all,
    device: config.device
  });
  const result = await cloudRequest(config, "/api/remote-sessions/upload", {
    method: "POST",
    body: bundle
  });
  return {
    codexHome,
    server: config.server,
    selected: bundle.sessions.length,
    skippedMissingRollouts: bundle.skippedMissingRollouts,
    ...result
  };
}

export async function runCloudPull({
  codexHome: explicitCodexHome,
  ids,
  all = false
} = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  const config = await requireCloudConfig(codexHome);
  const releaseLock = await acquireLock(codexHome, "cloud-pull");
  try {
    const bundle = await cloudRequest(config, "/api/remote-sessions/pull-bundle", {
      method: "POST",
      body: { ids, all }
    });
    const result = await applyPullBundle(codexHome, bundle);
    return {
      ...result,
      server: config.server,
      received: bundle.sessions?.length ?? 0
    };
  } finally {
    await releaseLock();
  }
}

export async function deleteCloudRemoteSession({
  codexHome: explicitCodexHome,
  id
} = {}) {
  if (!id) {
    throw new Error("Missing remote session id.");
  }
  const codexHome = normalizeCodexHome(explicitCodexHome);
  const config = await requireCloudConfig(codexHome);
  return await cloudRequest(config, `/api/remote-sessions/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}
