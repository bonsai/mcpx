import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ServerSpec } from "./types.js";
import { ENV_DIR, loadRegistry, RegistryEntry } from "./registry.js";

export type Lang = "go" | "rust" | "node" | "python";

const MCP_MARKERS = [
  // python
  "FastMCP(", "MCPServer(", "@mcp.tool", "mcp.run(", "mcp.server", "stdio_server",
  // go (mark3labs/mcp-go, modelcontextprotocol/go-sdk)
  "mcp.NewServer", "server.ServeStdio", "mcp-go", "modelcontextprotocol/go-sdk", "ServeStdio",
  // rust (rmcp)
  "rmcp", "serve_stdio", "ServerHandler", "transport_stdio",
  // ts
  "McpServer", "@modelcontextprotocol/sdk", "StdioServerTransport", "StreamableHTTPServerTransport",
];

const HTTP_MARKERS = [
  // python
  "run_streamable_http", "streamable_http", "uvicorn", "FastAPI(",
  // ts
  "StreamableHTTPServerTransport",
  // go
  "http.ListenAndServe", "ListenAndServeTLS", "http.Server{",
  // rust
  "HttpServerTransport", "serve_http", "axum::", "TcpListener::bind",
];

const RUNTIME_CMD = new Set([
  "npx", "pnpm", "yarn", "bun", "deno", "uvx", "uv", "python", "python3",
  "node", "tsx", "go", "cargo", "just", "make", "docker", "deno",
]);

const SKIP_DIRS = new Set([
  "node_modules", "target", ".git", ".venv", "venv", "dist", "build",
  "__pycache__", ".cargo", "vendor", ".mypy_cache", ".pytest_cache",
]);

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //
function isUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

function nameFrom(spec: string, fallback = "mcp"): string {
  if (isUrl(spec)) return spec.split("//", 2)[1]?.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
  const p = spec.replace(/^~/, process.env.HOME ?? "");
  if (existsSync(p)) return basename(p).replace(/\.[^.]+$/, "");
  return spec.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || fallback;
}

function walk(dir: string, exts: string[], maxDepth = 4): string[] {
  const out: string[] = [];
  const rec = (d: string, depth: number) => {
    if (depth > maxDepth) return;
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) rec(join(d, e.name), depth + 1);
      } else if (exts.some((x) => e.name.endsWith(x))) {
        out.push(join(d, e.name));
      }
    }
  };
  rec(dir, 0);
  return out;
}

function collectText(dir: string, exts: string[], cap = 400_000): string {
  let buf = "";
  for (const f of walk(dir, exts)) {
    try {
      if (statSync(f).size > 300_000) continue;
      buf += "\n" + readFileSync(f, "utf8");
    } catch {
      /* ignore */
    }
    if (buf.length > cap) break;
  }
  return buf;
}

export function detectTransport(text: string): "http" | "stdio" {
  return HTTP_MARKERS.some((m) => text.includes(m)) ? "http" : "stdio";
}

function detectPort(text: string, def = 8000): number {
  let m = text.match(/port\s*[=:]\s*["'`]?(\d{2,5})/i);
  if (m) return Number(m[1]);
  m = text.match(/["'`]:(?:\d{2,5})?["'`]?\s*\+?\s*|:(8\d{3}|9\d{3}|300\d|500\d|800\d)/);
  if (m) {
    const bare = text.match(/:(?:8\d{3}|30\d{2}|50\d{2}|40\d{2}|9\d{3})/);
    if (bare) return Number(bare[0].slice(1));
  }
  m = text.match(/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d{2,5})/);
  return m ? Number(m[1]) : def;
}

function detectPath(text: string, def = "/mcp"): string {
  let m = text.match(/streamable_http_path\s*=\s*["'`]([^"'`]+)/);
  if (m) return m[1];
  m = text.match(/mount\s*\(\s*["'`]([^"'`]+)["'`]/);
  if (m) return m[1];
  m = text.match(/["'`](\/[\w/-]*mcp[\w/-]*)["'`]/);
  return m ? m[1] : def;
}

// --------------------------------------------------------------------------- //
// language detection
// --------------------------------------------------------------------------- //
export function detectLang(dir: string): Lang | undefined {
  if (existsSync(join(dir, "go.mod"))) return "go";
  if (existsSync(join(dir, "Cargo.toml"))) return "rust";
  if (existsSync(join(dir, "package.json"))) return "node";
  if (
    existsSync(join(dir, "requirements.txt")) ||
    existsSync(join(dir, "pyproject.toml")) ||
    existsSync(join(dir, "setup.py"))
  )
    return "python";
  const py = walk(dir, [".py"], 2);
  if (py.length) return "python";
  const go = walk(dir, [".go"], 2);
  if (go.length) return "go";
  const rs = walk(dir, [".rs"], 2);
  if (rs.length) return "rust";
  const ts = walk(dir, [".ts", ".js", ".mjs"], 2);
  if (ts.length) return "node";
  return undefined;
}

// --------------------------------------------------------------------------- //
// python provisioning
// --------------------------------------------------------------------------- //
function provisionPython(dir: string): string {
  for (const c of [".venv/bin/python", "venv/bin/python"]) {
    if (existsSync(join(dir, c))) return join(dir, c);
  }
  const req = ["requirements.txt", "requirements/base.txt"].map((r) => join(dir, r)).find(existsSync);
  const pyproj = join(dir, "pyproject.toml");
  if (!req && !existsSync(pyproj)) return "python3";

  const hash = createHash("sha256");
  hash.update(process.version);
  if (req) hash.update(readFileSync(req));
  if (existsSync(pyproj)) hash.update(readFileSync(pyproj));
  const envdir = join(ENV_DIR, hash.digest("hex").slice(0, 16));
  const py = join(envdir, "bin", "python");
  if (existsSync(py)) return py;

  mkdirSync(ENV_DIR, { recursive: true });
  const pyver = process.env.MCPX_PYTHON ?? "3.12";
  process.stderr.write(`mcpx: provisioning python env for ${dir}\n`);
  const uv = which("uv");
  if (uv) {
    run([uv, "venv", envdir, "--python", pyver]);
    if (req) run([uv, "pip", "install", "--python", py, "-r", req]);
    else run([uv, "pip", "install", "--python", py, "-e", dir]);
  } else {
    run(["python3", "-m", "venv", envdir]);
    const pip = join(envdir, "bin", "pip");
    if (req) run([pip, "install", "-r", req]);
    else run([pip, "install", "-e", dir]);
  }
  return py;
}

function which(bin: string): string | undefined {
  const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function run(args: string[], cwd?: string): void {
  const r = spawnSync(args[0], args.slice(1), { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`command failed: ${args.join(" ")}`);
}

// --------------------------------------------------------------------------- //
// per-language specs
// --------------------------------------------------------------------------- //
function pythonEntrypoint(dir: string): string | undefined {
  const files = walk(dir, [".py"]);
  const scored: { score: number; depth: number; path: string }[] = [];
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (!MCP_MARKERS.some((m) => text.includes(m))) continue;
    const name = basename(f).toLowerCase();
    let score = MCP_MARKERS.reduce((s, m) => s + (text.split(m).length - 1), 0);
    if (name.includes("mcp")) score += 6;
    if (name.includes("server")) score += 4;
    if (["main.py", "app.py", "__main__.py"].includes(name)) score += 2;
    scored.push({ score, depth: f.split(/[\\/]/).length, path: f });
  }
  if (!scored.length) return undefined;
  scored.sort((a, b) => b.score - a.score || a.depth - b.depth || a.path.localeCompare(b.path));
  return scored[0].path;
}

function specPython(dir: string): ServerSpec {
  const entry = pythonEntrypoint(dir);
  if (!entry) throw new Error(`no MCP server found under ${dir}`);
  const text = readFileSync(entry, "utf8");
  const python = provisionPython(dir);
  const kind = detectTransport(text);
  const spec: ServerSpec = {
    name: basename(dir),
    kind,
    command: [python, entry],
    cwd: dir,
    source: entry,
  };
  if (kind === "http") {
    spec.port = detectPort(text);
    spec.path = detectPath(text);
  }
  return spec;
}

function specNode(dir: string): ServerSpec {
  const text = collectText(dir, [".ts", ".js", ".mjs", ".cjs"]);
  const kind = detectTransport(text);
  let cmd: string[];
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const binField = pkg.bin;
  const binPath = typeof binField === "string" ? binField : binField ? Object.values(binField)[0] : undefined;
  const entry = [
    "src/index.ts", "src/server.ts", "src/main.ts", "index.ts", "server.ts",
    "src/index.js", "dist/index.js", "index.js",
  ].find((f) => existsSync(join(dir, f)));
  if (entry?.endsWith(".ts")) cmd = ["npx", "--yes", "tsx", entry];
  else if (entry) cmd = ["node", entry];
  else if (binPath) cmd = ["npx", "--yes", String(binPath)];
  else cmd = ["npm", "run", "--silent", "start"];
  const spec: ServerSpec = { name: basename(dir), kind, command: cmd, cwd: dir, source: entry ?? "package.json" };
  if (kind === "http") {
    spec.port = detectPort(text);
    spec.path = detectPath(text);
  }
  return spec;
}

function goMainDir(dir: string): string {
  const files = walk(dir, [".go"]);
  const dirs = [...new Set(files.map((f) => dirname(f)))];
  const mains: string[] = [];
  for (const d of dirs) {
    const has = readdirSync(d).some((n) => n.endsWith(".go") && readFileSync(join(d, n), "utf8").includes("package main"));
    if (has) mains.push(d);
  }
  const cmdDirs = mains.filter((d) => d.includes(`${"/"}cmd${"/"}`) || d.endsWith("/cmd"));
  const pick = cmdDirs[0] ?? mains.find((d) => d === dir) ?? mains[0] ?? dir;
  return pick;
}

function specGo(dir: string): ServerSpec {
  const text = collectText(dir, [".go"]);
  const kind = detectTransport(text);
  const mainDir = goMainDir(dir);
  const rel = mainDir === dir ? "." : `.${mainDir.slice(dir.length)}`;
  const spec: ServerSpec = { name: basename(dir), kind, command: ["go", "run", rel], cwd: dir, source: rel };
  if (kind === "http") {
    spec.port = detectPort(text);
    spec.path = detectPath(text);
  }
  return spec;
}

function specRust(dir: string): ServerSpec {
  const text = collectText(dir, [".rs", ".toml"]);
  const kind = detectTransport(text);
  const cmd = ["cargo", "run", "--quiet"];
  const cargo = readFileSync(join(dir, "Cargo.toml"), "utf8");
  const binMatch = cargo.match(/\[\[bin\]\][^[]*name\s*=\s*"([^"]+)"/);
  if (binMatch) cmd.push("--bin", binMatch[1]);
  const spec: ServerSpec = { name: basename(dir), kind, command: cmd, cwd: dir, source: "Cargo.toml" };
  if (kind === "http") {
    spec.port = detectPort(text);
    spec.path = detectPath(text);
  }
  return spec;
}

function specFromDir(dir: string): ServerSpec {
  const lang = detectLang(dir);
  switch (lang) {
    case "go":
      return specGo(dir);
    case "rust":
      return specRust(dir);
    case "node":
      return specNode(dir);
    case "python":
      return specPython(dir);
    default:
      throw new Error(`no MCP server found under ${dir} (looked for go.mod, Cargo.toml, package.json, requirements.txt)`);
  }
}

function specFromFile(file: string): ServerSpec {
  const ext = extname(file);
  const text = (() => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  })();
  const kind = detectTransport(text);
  let spec: ServerSpec;
  if (ext === ".py") spec = { name: basename(file, ext), kind, command: ["python3", file], cwd: dirname(file), source: file };
  else if ([".ts", ".mts", ".cts"].includes(ext)) spec = { name: basename(file, ext), kind, command: ["npx", "--yes", "tsx", file], cwd: dirname(file), source: file };
  else if ([".js", ".mjs", ".cjs"].includes(ext)) spec = { name: basename(file, ext), kind, command: ["node", file], cwd: dirname(file), source: file };
  else if (ext === ".go") spec = { name: basename(file, ext), kind, command: ["go", "run", file], cwd: dirname(file), source: file };
  else if (ext === ".rs") return specFromDir(dirname(file));
  else throw new Error(`don't know how to run ${file}`);
  if (kind === "http") {
    spec.port = detectPort(text);
    spec.path = detectPath(text);
  }
  return spec;
}

function specFromRegistry(name: string, cfg: RegistryEntry): ServerSpec {
  if (cfg.url) return { name, kind: "http", url: cfg.url, source: cfg._source ?? "registry" };
  let cmd = cfg.command;
  if (typeof cmd === "string") cmd = cmd.split(/\s+/);
  if (!cmd || !cmd.length) throw new Error(`registry entry '${name}' has no command or url`);
  const command = [...cmd, ...(cfg.args ?? [])];
  return {
    name,
    kind: "stdio",
    command,
    cwd: cfg.cwd,
    env: cfg.env ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)])) : undefined,
    source: cfg._source ?? "registry",
  };
}

// --------------------------------------------------------------------------- //
// public resolve
// --------------------------------------------------------------------------- //
export function resolveSpec(spec: string, extra: string[] = []): ServerSpec {
  const s = spec.trim().replace(/^~/, process.env.HOME ?? "");
  let out: ServerSpec;

  if (isUrl(s)) {
    out = { name: nameFrom(s), kind: "http", url: s, source: "url" };
  } else if (existsSync(s)) {
    out = statSync(s).isDirectory() ? specFromDir(s) : specFromFile(s);
  } else {
    const reg = loadRegistry();
    if (s in reg) {
      out = specFromRegistry(s, reg[s]);
    } else {
      const tokens = s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
      if (tokens.length && (RUNTIME_CMD.has(tokens[0]) || tokens[0].includes("/"))) {
        out = { name: nameFrom(tokens[0]), kind: "stdio", command: tokens, source: "command" };
      } else {
        const known = Object.keys(reg).sort().join(", ") || "(none)";
        throw new Error(`'${spec}' is not a path, url, command or known name.\nknown: ${known}`);
      }
    }
  }

  if (extra.length) out.command = [...(out.command ?? []), ...extra];
  if (out.kind === "http" && !out.url && out.port) out.url = `http://127.0.0.1:${out.port}${out.path ?? "/mcp"}`;
  return out;
}
