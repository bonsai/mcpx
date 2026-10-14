#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { resolveSpec } from "./spec.js";
import { loadRegistry } from "./registry.js";
import { run, printTools, resultText } from "./client.js";
import { launchHttp, portOpen, kill, logPath, env } from "./proc.js";
import { ServerSpec, toJson } from "./types.js";
import { RUN_DIR } from "./registry.js";

const HELP = `mcpx - run any MCP server on the spot (tsx for MCP)

Usage:
  mcpx specs                       list servers found in local config
  mcpx show   <spec>               print the resolved launch spec
  mcpx ls     <spec> [--json]      boot the server and list its tools
  mcpx call   <spec> <tool> [json] boot, call one tool, print result, tear down
  mcpx shell  <spec>               boot an interactive REPL for calling tools
  mcpx run    <spec>               run in the foreground (stdio passthrough)
  mcpx up     <spec>               start an http server in the background
  mcpx down   <name>               stop a background server
  mcpx status                      list background servers
  mcpx logs   <name>               print a server's log

<spec> = a repo path (Go/Python/Rust/TS auto-detected), a server file, an http
         url, a shell command (npx/uvx/go run/cargo run/...), or a name from
         your local mcp.json. Everything after -- is passed to the server.`;

function splitExtra(args: string[]): { pos: string[]; extra: string[] } {
  const i = args.indexOf("--");
  if (i === -1) return { pos: args, extra: [] };
  return { pos: args.slice(0, i), extra: args.slice(i + 1) };
}

function fail(msg: string): never {
  console.error(`mcpx: ${msg}`);
  process.exit(1);
}

async function cmdSpecs(): Promise<void> {
  const reg = loadRegistry();
  const names = Object.keys(reg).sort();
  if (!names.length) return void console.log("(no servers in config)");
  for (const name of names) {
    const cfg = reg[name];
    const target = cfg.url ?? [cfg.command, ...(cfg.args ?? [])].flat().filter(Boolean).join(" ");
    console.log(`  ${name.padEnd(24)} ${target}   [${cfg._source ?? ""}]`);
  }
}

async function cmdLs(pos: string[], extra: string[], json: boolean): Promise<void> {
  if (!pos[0]) fail("ls needs a <spec>");
  const spec = resolveSpec(pos[0], extra);
  const res = await run(spec, (c) => c.listTools());
  if (json) console.log(JSON.stringify(res.tools, null, 2));
  else {
    console.log(`${spec.name}: ${res.tools.length} tools`);
    printTools(res.tools);
  }
}

async function cmdCall(pos: string[], extra: string[]): Promise<void> {
  const [specArg, tool, jsonArg] = pos;
  if (!specArg || !tool) fail("call needs <spec> <tool> [json]");
  const args = jsonArg ? JSON.parse(jsonArg) : {};
  const spec = resolveSpec(specArg, extra);
  const res = await run(spec, (c) => c.callTool({ name: tool, arguments: args }) as Promise<any>);
  console.log(resultText(res));
  if (res?.isError) process.exit(1);
}

async function cmdShell(pos: string[], extra: string[]): Promise<void> {
  if (!pos[0]) fail("shell needs a <spec>");
  const spec = resolveSpec(pos[0], extra);
  await run(spec, async (c) => {
    const tools = (await c.listTools()).tools;
    console.log(`connected: ${spec.name} (${tools.length} tools). 'tools' list, 'call <tool> {json}', 'quit'.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      let line: string;
      try {
        line = (await rl.question("mcpx> ")).trim();
      } catch {
        break;
      }
      if (["quit", "exit", "q"].includes(line)) break;
      if (!line) continue;
      if (line === "tools") {
        printTools(tools);
        continue;
      }
      if (line.startsWith("call ")) {
        const rest = line.slice(5).trim();
        const sp = rest.indexOf(" ");
        const name = sp === -1 ? rest : rest.slice(0, sp);
        const raw = sp === -1 ? "" : rest.slice(sp + 1).trim();
        let payload = {};
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch (e) {
          console.log(`bad json: ${(e as Error).message}`);
          continue;
        }
        const res = await c.callTool({ name, arguments: payload });
        console.log(resultText(res));
        continue;
      }
      console.log("commands: tools | call <tool> <json> | quit");
    }
    rl.close();
  });
}

async function cmdShow(pos: string[], extra: string[]): Promise<void> {
  if (!pos[0]) fail("show needs a <spec>");
  console.log(JSON.stringify(toJson(resolveSpec(pos[0], extra)), null, 2));
}

async function cmdRun(pos: string[], extra: string[]): Promise<void> {
  if (!pos[0]) fail("run needs a <spec>");
  const spec = resolveSpec(pos[0], extra);
  if (spec.kind === "http") {
    const proc = await launchHttp(spec, false);
    console.error(`mcpx: ${spec.name} up on ${spec.url} (log: ${logPath(spec.name)})`);
    const stop = () => kill(proc);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    proc.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  const child = spawn(spec.command![0], spec.command!.slice(1), {
    cwd: spec.cwd,
    env: env(spec),
    stdio: "inherit",
  });
  child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
}

async function cmdUp(pos: string[], extra: string[]): Promise<void> {
  if (!pos[0]) fail("up needs a <spec>");
  const spec = resolveSpec(pos[0], extra);
  if (spec.kind !== "http") fail("'up' is for http servers; use 'run' for stdio");
  const proc = await launchHttp(spec);
  mkdirSync(RUN_DIR, { recursive: true });
  const state = { name: spec.name, pid: proc.pid, url: spec.url, command: spec.command, log: logPath(spec.name) };
  writeFileSync(join(RUN_DIR, `${spec.name}.json`), JSON.stringify(state));
  console.log(`${spec.name} up -> ${spec.url} (pid ${proc.pid})`);
}

async function cmdDown(name?: string): Promise<void> {
  if (!name) fail("down needs a <name>");
  const f = join(RUN_DIR, `${name}.json`);
  if (!existsSync(f)) fail(`no server named '${name}' is up`);
  const state = JSON.parse(readFileSync(f, "utf8"));
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    /* gone */
  }
  unlinkSync(f);
  console.log(`${name} down`);
}

async function cmdStatus(): Promise<void> {
  if (!existsSync(RUN_DIR)) return void console.log("(no servers up)");
  const files = readdirSync(RUN_DIR).filter((f) => f.endsWith(".json"));
  if (!files.length) return void console.log("(no servers up)");
  for (const f of files.sort()) {
    const s = JSON.parse(readFileSync(join(RUN_DIR, f), "utf8"));
    const port = Number(s.url?.split(":").pop()?.split("/")[0] ?? 0);
    const up = port ? await portOpen(port) : false;
    console.log(`  ${s.name.padEnd(20)} ${up ? "up  " : "down"}  ${s.url}  pid ${s.pid}`);
  }
}

async function cmdLogs(name?: string): Promise<void> {
  if (!name) fail("logs needs a <name>");
  const p = logPath(name);
  if (!existsSync(p)) fail(`no log for '${name}'`);
  process.stdout.write(readFileSync(p, "utf8"));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const json = rest.includes("--json");
  const cleaned = rest.filter((a) => a !== "--json");
  const { pos, extra } = splitExtra(cleaned);

  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      return void console.log(HELP);
    case "--version":
    case "-v":
      return void console.log("mcpx 0.1.0");
    case "specs":
      return cmdSpecs();
    case "show":
      return cmdShow(pos, extra);
    case "ls":
      return cmdLs(pos, extra, json);
    case "call":
      return cmdCall(pos, extra);
    case "shell":
      return cmdShell(pos, extra);
    case "run":
      return cmdRun(pos, extra);
    case "up":
      return cmdUp(pos, extra);
    case "down":
      return cmdDown(pos[0]);
    case "status":
      return cmdStatus();
    case "logs":
      return cmdLogs(pos[0]);
    default:
      fail(`unknown command '${cmd}'. Try: mcpx --help`);
  }
}

main().catch((e) => fail((e as Error).message));
