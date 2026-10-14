import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const CACHE = process.env.MCPX_CACHE ?? join(HOME, ".cache", "mcpx");
export const ENV_DIR = join(CACHE, "envs");
export const RUN_DIR = join(CACHE, "run");
export const LOG_DIR = join(CACHE, "logs");
export const CONFIG = process.env.MCPX_CONFIG ?? join(HOME, ".config", "mcpx", "servers.json");

export interface RegistryEntry {
  command?: string | string[];
  args?: string[];
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
  _source?: string;
}

function merge(raw: any, servers: Record<string, RegistryEntry>, source: string): void {
  const map = raw?.mcpServers ?? raw?.servers;
  if (!map || typeof map !== "object") return;
  for (const [name, cfg] of Object.entries(map)) {
    if (!cfg || typeof cfg !== "object") continue;
    servers[name] = { ...(cfg as RegistryEntry), _source: source };
  }
}

function readJson(path: string): any | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function loadRegistry(): Record<string, RegistryEntry> {
  const servers: Record<string, RegistryEntry> = {};
  const files = [
    CONFIG,
    join(HOME, ".pi", "agent", "mcp.json"),
    join(HOME, ".pi", "agent", ".mcp.json"),
    join(HOME, ".opencode", "mcp.json"),
  ];
  for (const f of files) {
    if (existsSync(f)) merge(readJson(f), servers, f);
  }
  const skills = join(HOME, ".pi", "skills");
  if (existsSync(skills)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(skills);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const sj = join(skills, name, "mcp", "server.json");
      if (!existsSync(sj)) continue;
      const cfg = readJson(sj);
      if (!cfg) continue;
      const key = cfg.name ?? name;
      servers[key] = { ...cfg, _source: sj };
    }
  }
  return servers;
}
