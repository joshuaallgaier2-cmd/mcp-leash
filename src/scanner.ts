import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { classifyTool } from "./classifier.js";
import { normalizeServerName, transportOf } from "./discovery.js";
import { matchPreset, type Preset, presetOfflineTools } from "./presets/index.js";
import { fullToolName } from "./settings.js";
import { GroupStdioTransport } from "./stdio-group.js";
import type { Classification, DiscoveredServer, Risk, ServerConfig, ToolInfo } from "./types.js";

export interface ScannedTool {
  name: string;
  /** Normalized server name (the `<server>` in mcp__<server>__<tool>). */
  server: string;
  fullName: string;
  risk: Risk;
  reason: string;
  source: Classification["source"];
}

export interface ScannedServer {
  name: string;
  normalizedName: string;
  scope: DiscoveredServer["scope"];
  transport: "stdio" | "http" | "sse" | "ws";
  target: string;
  preset?: string;
  source: "live" | "preset" | "none";
  error?: string;
  /** Shown instead of an error when the server was deliberately not started. */
  note?: string;
  tools: ScannedTool[];
}

export const CONNECT_TIMEOUT_MS = 10_000;
export const NOT_STARTED_NOTE = "(not started: project server — rerun with --trust-project)";

/**
 * Project-scope (.mcp.json) servers come from the repo, so they need trust: stdio ones run
 * the repo's commands, and remote ones would receive ${VAR}-expanded secrets in URL/headers.
 * A plugin installed at project scope is in the same position.
 */
export function needsTrust(server: DiscoveredServer): boolean {
  return server.scope === "project" || server.requiresTrust === true;
}

/** Expand ${VAR} and ${VAR:-default} like Claude Code does in MCP configs. */
export function expandVars(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_m, v, d) => env[v] ?? d ?? "",
  );
}

const expandAll = (r: Record<string, string> | undefined) =>
  r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, expandVars(String(v))])) : undefined;

export function describeTarget(c: ServerConfig): string {
  if (transportOf(c) === "stdio") return [c.command ?? "", ...(c.args ?? [])].join(" ").trim();
  return c.url ?? "";
}

function oneLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0]?.slice(0, 160) ?? "unknown error";
}

function failReason(e: unknown): string {
  const m = oneLine(e);
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|auth/i.test(m)) return `needs auth: ${m}`;
  if (/ENOENT/.test(m)) return `command not found: ${m}`;
  if (/Connection closed/i.test(m))
    return "server exited before answering; check its command and args";
  return m;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(message)), Math.max(1, ms));
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

async function listAll(client: Client): Promise<ToolInfo[]> {
  const tools: ToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const r = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of r.tools) {
      tools.push({ name: t.name, description: t.description, annotations: t.annotations });
    }
    cursor = r.nextCursor;
  } while (cursor);
  return tools;
}

/** One shared budget for every step (connect, list, fallback) of a single server scan. */
class Deadline {
  private readonly end: number;
  constructor(readonly totalMs: number) {
    this.end = Date.now() + totalMs;
  }
  left(): number {
    return this.end - Date.now();
  }
  message(step: string): string {
    return `${step} timed out after ${this.totalMs / 1000}s`;
  }
}

async function tryConnect(transport: Transport, deadline: Deadline): Promise<ToolInfo[]> {
  const client = new Client({ name: "mcp-leash", version: "0.1.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), deadline.left(), deadline.message("connect"));
    return await withTimeout(listAll(client), deadline.left(), deadline.message("tools/list"));
  } finally {
    // close() terminates a spawned stdio child (and its process group); swallow errors.
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

function stdioTransport(config: ServerConfig, cwd: string): Transport {
  const command = expandVars(config.command ?? "");
  const args = (config.args ?? []).map((a) => expandVars(String(a)));
  const env = { ...getDefaultEnvironment(), ...expandAll(config.env) };
  if (process.platform === "win32") {
    return new StdioClientTransport({ command, args, env, stderr: "ignore", cwd });
  }
  return new GroupStdioTransport({ command, args, env, cwd });
}

export async function fetchTools(
  config: ServerConfig,
  opts: { cwd: string; timeoutMs?: number },
): Promise<ToolInfo[]> {
  const deadline = new Deadline(opts.timeoutMs ?? CONNECT_TIMEOUT_MS);
  const kind = transportOf(config);
  if (kind === "stdio") {
    if (!config.command) throw new Error("stdio server has no command");
    return tryConnect(stdioTransport(config, opts.cwd), deadline);
  }
  if (kind === "ws") throw new Error("ws transport is not supported yet");
  if (!config.url) throw new Error("remote server has no url");
  const url = new URL(expandVars(config.url));
  const requestInit = { headers: expandAll(config.headers) };
  if (kind === "sse") return tryConnect(new SSEClientTransport(url, { requestInit }), deadline);
  try {
    return await tryConnect(new StreamableHTTPClientTransport(url, { requestInit }), deadline);
  } catch (e) {
    if (/\b(401|403)\b|unauthori[sz]ed/i.test(oneLine(e)) || deadline.left() <= 0) throw e;
    try {
      return await tryConnect(new SSEClientTransport(url, { requestInit }), deadline);
    } catch {
      throw e;
    }
  }
}

function classifyAll(server: DiscoveredServer, tools: ToolInfo[], preset?: Preset): ScannedTool[] {
  const normalized = normalizeServerName(server.name);
  return tools.map((t) => {
    const c = classifyTool(t, preset);
    return {
      name: t.name,
      server: normalized,
      fullName: fullToolName(normalized, t.name),
      risk: c.risk,
      reason: c.reason,
      source: c.source,
    };
  });
}

export async function scanServer(
  server: DiscoveredServer,
  opts: { offline: boolean; cwd: string; timeoutMs?: number; trustProject?: boolean },
): Promise<ScannedServer> {
  const preset = matchPreset(server.name, server.config);
  const base = {
    name: server.name,
    normalizedName: normalizeServerName(server.name),
    scope: server.scope,
    transport: transportOf(server.config),
    target: describeTarget(server.config),
    ...(preset ? { preset: preset.id } : {}),
  };

  const notStarted = !opts.offline && !opts.trustProject && needsTrust(server);
  if (opts.offline || notStarted) {
    const note = notStarted ? { note: NOT_STARTED_NOTE } : {};
    if (!preset) return { ...base, ...note, source: "none", tools: [] };
    const tools = presetOfflineTools(preset).map<ToolInfo>((name) => ({ name }));
    return { ...base, ...note, source: "preset", tools: classifyAll(server, tools, preset) };
  }

  try {
    const tools = await fetchTools(server.config, opts);
    return { ...base, source: "live", tools: classifyAll(server, tools, preset) };
  } catch (e) {
    return { ...base, source: "none", error: failReason(e), tools: [] };
  }
}

export async function scanAll(
  servers: DiscoveredServer[],
  opts: { offline: boolean; cwd: string; timeoutMs?: number; trustProject?: boolean },
): Promise<ScannedServer[]> {
  return Promise.all(servers.map((s) => scanServer(s, opts)));
}
