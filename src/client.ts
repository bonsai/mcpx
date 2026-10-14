import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ServerSpec } from "./types.js";
import { launchHttp, portOpen, kill } from "./proc.js";

export type Session = Client;

async function connected<T>(spec: ServerSpec, fn: (c: Session) => Promise<T>): Promise<T> {
  const client = new Client({ name: "mcpx", version: "0.1.0" });
  const transport =
    spec.kind === "stdio"
      ? new StdioClientTransport({
          command: spec.command![0],
          args: spec.command!.slice(1),
          cwd: spec.cwd,
          env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
        })
      : new StreamableHTTPClientTransport(new URL(spec.url!));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Boot an http server ephemerally if needed, run fn, then tear it down. */
export async function run<T>(spec: ServerSpec, fn: (c: Session) => Promise<T>): Promise<T> {
  if (spec.kind === "http" && spec.command && !(await portOpen(spec.port ?? 8000))) {
    const proc = await launchHttp(spec);
    try {
      return await connected(spec, fn);
    } finally {
      kill(proc);
    }
  }
  return connected(spec, fn);
}

export function printTools(tools: Tool[]): void {
  for (const t of tools) {
    const first = (t.description ?? "").trim().split("\n")[0];
    const line = first ? `  ${t.name}  -  ${first.slice(0, 100)}` : `  ${t.name}`;
    console.log(line);
  }
}

export function resultText(res: any): string {
  const parts: string[] = [];
  for (const item of res?.content ?? []) {
    if (item && typeof item.text === "string") parts.push(item.text);
    else parts.push(JSON.stringify(item));
  }
  if (res?.structuredContent) parts.push(JSON.stringify(res.structuredContent, null, 2));
  return parts.join("\n");
}
