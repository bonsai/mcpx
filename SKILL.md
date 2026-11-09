---
name: mcpx
description: MCP サーバーを恒久接続せず、必要なときだけ起動して 1 回使って破棄するランナー（"uvx for MCP"）。repo / サーバーファイル / npm コマンド / URL / mcp.json の名前を指して ls・call・shell・run・up/down できる。「mcpx」「mcp を一時的に使う」「mcp サーバーを起動して」「mcp を呼んで」「mcp のツール一覧」「mcp を試す」「mcp 繋ぎっぱなしをやめたい」などで発動。恒久登録は add-mcp、健康診断は mcp-doctor の担当。
---

# mcpx — その場で MCP を走らせる

`uvx` の MCP 版。リポジトリ・サーバーファイル・npm コマンド・URL・`mcp.json` の名前を指すと
**起動 → 実行 → 破棄** する。どのエージェントの `mcpServers` にも書き込まない。

**方針: MCP は常時接続しない。** opencode の `mcp` は空にしてあり、必要なときだけこのスキルから
mcpx で短期間だけ起動する。

## 実体

| 項目 | 値 |
|---|---|
| リポジトリ | `C:\Users\dance\Documents\MEGA\WORKSPACE\mcp\mcpx` |
| エントリ | `node dist\index.js`（`dist/` はビルド済み） |
| ランナー | `C:\Users\dance\.config\opencode\skills\mcpx\mcpx.cmd`（PATH には入れない） |
| 依存 | Node ≥18、`@modelcontextprotocol/sdk`（repo の `node_modules` に導入済み） |
| キャッシュ | `~/.cache/mcpx/`（`envs/` `run/` `logs/` いつ削除してもよい） |

## 使い方

```powershell
# 同梱ランナー経由（推奨）
& "C:\Users\dance\.config\opencode\skills\mcpx\mcpx.cmd" specs
& "C:\Users\dance\.config\opencode\skills\mcpx\mcpx.cmd" ls   <spec>
& "C:\Users\dance\.config\opencode\skills\mcpx\mcpx.cmd" call <spec> <tool> '{\"key\":\"value\"}'   # ← PowerShell は内側の " を \" にエスケープ

# もしくは node 直叩き
node "C:\Users\dance\Documents\MEGA\WORKSPACE\mcp\mcpx\dist\index.js" ls <spec>
```

> ⚠️ **PowerShell の引用符** — `call ... '{"k":v}'` は PowerShell→cmd の段で `"` が消え、
> `mcpx: Expected property name or '}' in JSON` になる。内側の二重引用符は `\"` にする:
> `& $mcpx call vectorcraft render_preview '{\"max_side\":800}'`
> もしくは **REPL を使う**（引用符問題が無い。複数呼び出しも楽）:
> ```powershell
> & $mcpx shell vectorcraft
> mcpx> call render_preview {"max_side":800}
> mcpx> quit
> ```

| コマンド | 説明 |
|---|---|
| `specs` | ローカル設定に見つかるサーバー一覧 |
| `show <spec>` | 解決後の起動 spec を表示（起動はしない） |
| `ls <spec> [--json]` | 起動 → ツール一覧 → 破棄 |
| `call <spec> <tool> [json]` | 起動 → 1 ツール実行 → 結果表示 → 破棄 |
| `shell <spec>` | 対話 REPL（複数ツールを続けて叩くとき） |
| `run <spec>` | 前面 stdio（MCP ホストに渡すとき） |
| `up/down/status/logs` | HTTP サーバーのバックグラウンド起動・停止・状態・ログ |

`--` 以降はサーバーコマンドへそのまま渡る。

### spec の例

```powershell
mcpx.cmd ls "npx -y @playwright/mcp"           # 任意コマンド
mcpx.cmd ls https://example.com/mcp            # 起動済み HTTP サーバー
mcpx.cmd ls C:\Users\dance\lms-mcp             # ディレクトリ（TS/Python/Go/Rust 自動判定）
mcpx.cmd call C:\Users\dance\wiki\marriage-mcp.py ask '{"question":"..."}'
mcpx.cmd ls browse                             # mcp.json の名前
```

## 解決順

1. `http(s)://…` → HTTP MCP（起動済み）
2. 既存パス → ディレクトリ（Go/Python/Rust/TS 自動判定）または単一サーバーファイル
3. 名前 → `~/.config/mcpx/servers.json` / `~/.pi/agent/mcp.json` / `~/.opencode/mcp.json` / `~/.pi/skills/*/mcp/server.json`
4. それ以外は shell コマンド（`npx …` / `uvx …` / `go run …` / `cargo run …`）

Python 依存は `~/.cache/mcpx/envs/` のハッシュ付き venv に導入（`MCPX_PYTHON` で上書き）。
ホスト設定は書き換えない。

## いま名前で引けるサーバー

`mcpx specs` で確認する。現状 `~/.pi/agent/mcp.json` から:
`browse` / `jules-cli` / `jules-github` / `jules-kanban` / `takt`。
`~/.opencode/mcp.json` は空（`{"mcpServers":{}}`）。

## ワークフロー

1. `specs` で名前を確認、無ければパスかコマンドで直接指す
2. `ls` でツールとスキーマを確認
3. `call` で必要なツールだけ実行（複数なら `shell`）
4. 終わったら何も残らない。常駐させたいものだけ `add-mcp` で登録する

## 関連

- 恒久登録: `add-mcp` スキル
- 健康診断: `mcp-doctor`
- 登録済み MCP の管理: `mcpman` スキル（CLI。MCP 登録は不要）
