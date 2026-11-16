import { isAbsolute, relative } from "node:path";
import pc from "picocolors";
import type { ScanResult } from "./common.js";
import type { ScannedServer, ScannedTool } from "./scanner.js";
import { type RuleSets, toolStatus } from "./settings.js";
import type { Risk } from "./types.js";

const ORDER: Record<Risk, number> = { critical: 0, write: 1, unknown: 2, read: 3 };

export function badge(risk: Risk): string {
  const label = risk.toUpperCase().padEnd(8);
  switch (risk) {
    case "critical":
      return pc.bold(pc.bgRed(pc.white(` ${label}`)));
    case "write":
      return pc.bold(pc.bgYellow(pc.black(` ${label}`)));
    case "read":
      return pc.bold(pc.bgGreen(pc.black(` ${label}`)));
    default:
      return pc.bold(pc.bgBlue(pc.white(` ${label}`)));
  }
}

export interface Summary {
  servers: number;
  tools: number;
  critical: number;
  write: number;
  read: number;
  unknown: number;
}

export function summarize(servers: ScannedServer[]): Summary {
  const s: Summary = {
    servers: servers.length,
    tools: 0,
    critical: 0,
    write: 0,
    read: 0,
    unknown: 0,
  };
  for (const srv of servers) {
    for (const t of srv.tools) {
      s.tools++;
      s[t.risk]++;
    }
  }
  return s;
}

export function summaryLine(s: Summary): string {
  const base = `${s.servers} server${s.servers === 1 ? "" : "s"}, ${s.tools} tool${s.tools === 1 ? "" : "s"}: ${s.critical} critical, ${s.write} write, ${s.read} read`;
  return s.unknown ? `${base}, ${s.unknown} unknown` : base;
}

export function statusOf(tool: ScannedTool, rules: RuleSets) {
  return toolStatus(tool.fullName, rules, tool.server);
}

export function statusTag(st: ReturnType<typeof toolStatus>): string {
  if (st === "denied") return pc.red("[denied]");
  if (st === "ask") return pc.yellow("[ask]");
  if (st === "allowed") return pc.dim("[allowed]");
  return "";
}

export function toJson(r: ScanResult, rules: RuleSets) {
  return {
    project: r.project,
    warnings: r.warnings,
    servers: r.servers.map((s) => ({
      name: s.name,
      scope: s.scope,
      transport: s.transport,
      target: s.target,
      preset: s.preset ?? null,
      source: s.source,
      ...(s.error ? { error: s.error } : {}),
      ...(s.note ? { note: s.note } : {}),
      tools: s.tools.map((t) => ({
        name: t.name,
        fullName: t.fullName,
        risk: t.risk,
        reason: t.reason,
        status: toolStatus(t.fullName, rules, t.server) ?? null,
      })),
    })),
    summary: summarize(r.servers),
  };
}

export function renderScan(r: ScanResult, rules: RuleSets, offline: boolean): string {
  const out: string[] = [];
  out.push(`${pc.bold("mcp-leash scan")}  ${pc.dim(displayPath(r.project))}`);
  for (const w of r.warnings) out.push(pc.yellow(`⚠ ${w}`));
  if (r.servers.length === 0) {
    out.push("", "No MCP servers found (checked ~/.claude.json, .mcp.json and installed plugins).");
    return out.join("\n");
  }

  for (const s of r.servers) {
    out.push(
      "",
      `${pc.bold(s.name)} ${pc.dim(`(${s.scope} · ${s.transport} · ${truncate(s.target, 60)})`)}`,
    );
    if (s.error) {
      out.push(`  ${pc.yellow(`⚠ could not connect (${s.error})`)}`);
      continue;
    }
    if (s.note) out.push(`  ${pc.yellow(s.note)}`);
    if (s.tools.length === 0) {
      if (!s.note) {
        out.push(
          offline && !s.preset
            ? pc.dim("  no preset for this server; run without --offline to scan it")
            : pc.dim("  no tools"),
        );
      }
      continue;
    }
    const tools = [...s.tools].sort(
      (a, b) => ORDER[a.risk] - ORDER[b.risk] || a.name.localeCompare(b.name),
    );
    const width = Math.max(...tools.map((t) => t.name.length));
    for (const t of tools) {
      const tag = statusTag(toolStatus(t.fullName, rules, t.server));
      out.push(
        `  ${badge(t.risk)} ${t.name.padEnd(width)}  ${pc.dim(t.reason)}${tag ? `  ${tag}` : ""}`,
      );
    }
  }

  const sum = summarize(r.servers);
  out.push("", pc.bold(summaryLine(sum)));
  if (sum.tools > 0) out.push("", `Run: ${pc.cyan("npx mcp-leash lock")}`);
  return out.join("\n");
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Show the project relative to cwd when it lives under it, else absolute. */
export function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  if (rel === "") return ".";
  return rel.startsWith("..") || isAbsolute(rel) ? p : rel;
}
