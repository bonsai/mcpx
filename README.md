# mcpx

**Run any MCP server on the spot.** `tsx` for the Model Context Protocol.

Point `mcpx` at a repo, a server file, an npm command, a URL, or a name from
your local `mcp.json` — it boots the server, does the work (`ls` / `call` /
`shell`), and tears it down again. Nothing is written to any agent's permanent
`mcpServers` config. Use a server for one call, one task, one session.

## Why

Permanent MCP registrations pile up: dead servers, wrong paths, ports that are
never up. `mcpx` makes a server ephemeral instead — like `uvx foo` or
`tsx file.ts` runs code without installing anything.

## Install

```bash
git clone https://github.com/bonsai/mcpx
cd mcpx
npm install        # builds dist/
npm link           # or: node dist/index.js ...
```

## Usage

```bash
mcpx specs                                  # servers found in local config
mcpx ls   ~/portfolio-manager               # boot + list tools + tear down
mcpx call ~/portfolio-manager get_top_projects
mcpx call ~/portfolio-manager score_repo '{"stars":100,"language":"Rust"}'
mcpx shell ~/portfolio-manager              # interactive REPL
mcpx run  ~/psychedelic-pose-projection     # foreground stdio (for MCP hosts)

mcpx ls https://example.com/mcp             # talk to a running http server
mcpx ls "npx -y @playwright/mcp"            # any command works
mcpx ls orerepo-mcp                         # a name from your mcp.json

mcpx up   ./some-http-server                # background http server
mcpx status && mcpx logs some-http-server && mcpx down some-http-server
```

Everything after `--` is passed through to the server command.

## Language support

`mcpx` detects the project type and provisions what it needs, on demand:

| Language   | Detected by                       | Runs as                                  |
| ---------- | --------------------------------- | ---------------------------------------- |
| TypeScript | `package.json`, `*.ts`            | `npx tsx <entry>` / `node <entry>`       |
| Python     | `requirements.txt`, `pyproject.toml`, `*.py` | ephemeral `uv` venv, then `python <entry>` |
| Go         | `go.mod`, `*.go`                  | `go run ./cmd/...`                       |
| Rust       | `Cargo.toml`, `*.rs`              | `cargo run`                              |

Python deps are installed into a cached, hash-keyed venv under
`~/.cache/mcpx/envs/` (override the interpreter with `MCPX_PYTHON`). Go/Rust
build caches are reused by their own toolchains.

## How a spec is resolved

1. `http(s)://…` → an HTTP MCP server (already running).
2. An existing path → directory (Go/Python/Rust/TS auto-detected) or a single
   server file.
3. A name present in `~/.config/mcpx/servers.json`, `~/.pi/agent/mcp.json`,
   `~/.opencode/mcp.json`, or `~/.pi/skills/*/mcp/server.json`.
4. Otherwise a shell command (`npx …`, `uvx …`, `go run …`, `cargo run …`).

Transport (stdio vs http) and the port/path are inferred from the server source.

## Cache

Everything ephemeral lives under `~/.cache/mcpx/` (`envs/`, `run/`, `logs/`).
Delete it freely; no host config is ever modified.

## License

MIT
