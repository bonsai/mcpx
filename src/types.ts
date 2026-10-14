export type Kind = "stdio" | "http";

export interface ServerSpec {
  name: string;
  kind: Kind;
  command?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  port?: number;
  path?: string;
  source?: string;
}

export function toJson(spec: ServerSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}
