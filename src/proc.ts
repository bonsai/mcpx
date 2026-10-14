import { spawn, ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { openSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ServerSpec } from "./types.js";
import { LOG_DIR } from "./registry.js";

export function logPath(name: string): string {
  mkdirSync(LOG_DIR, { recursive: true });
  return join(LOG_DIR, `${name}.log`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(400, () => done(false));
  });
}

export async function waitPort(port: number, timeoutMs = 40_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await portOpen(port)) return true;
    await sleep(300);
  }
  return false;
}

export function env(spec: ServerSpec): NodeJS.ProcessEnv {
  return { ...process.env, ...(spec.env ?? {}) };
}

export function launch(spec: ServerSpec, unref = true): ChildProcess {
  const log = logPath(spec.name);
  const out = openSync(log, "a");
  const proc = spawn(spec.command![0], spec.command!.slice(1), {
    cwd: spec.cwd,
    env: env(spec),
    stdio: ["ignore", out, out],
    detached: true,
  });
  if (unref) proc.unref();
  return proc;
}

export async function launchHttp(spec: ServerSpec, unref = true): Promise<ChildProcess> {
  const proc = launch(spec, unref);
  if (!(await waitPort(spec.port ?? 8000))) {
    kill(proc);
    throw new Error(`${spec.name} did not open port ${spec.port ?? 8000}. See ${logPath(spec.name)}`);
  }
  return proc;
}

export function kill(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
