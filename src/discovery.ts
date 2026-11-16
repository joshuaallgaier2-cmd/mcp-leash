import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeServerName } from "./names.js";
import { enabledPlugins } from "./settings.js";
import type { DiscoveredServer, Scope, ServerConfig } from "./types.js";

export function transportOf(config: ServerConfig): "stdio" | "http" | "sse" | "ws" {
  if (config.type === "sse" || config.type === "ws" || config.type === "http") return config.type;
  if (config.type === "stdio") return "stdio";
  if (config.command) return "stdio";
  return config.url ? "http" : "stdio";
}

export { normalizeServerName };

export interface DiscoverOpts {
  home: string;
  project: string;
}

function readJson(path: string, warnings: string[]): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const v = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch (e) {
    warnings.push(`${path}: invalid JSON (${(e as Error).message})`);
    return undefined;
  }
}

function pick(block: unknown, scope: Scope, file: string): DiscoveredServer[] {
  if (!block || typeof block !== "object") return [];
  const out: DiscoveredServer[] = [];
  for (const [name, cfg] of Object.entries(block as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
    out.push({ name, scope, config: cfg as ServerConfig, file });
  }
  return out;
}

function projectKeys(project: string): string[] {
  const abs = resolve(project);
  const keys = new Set([abs]);
  try {
    keys.add(realpathSync(abs));
  } catch {
    /* project dir may not exist */
  }
  return [...keys];
}

// ---------- plugins ----------

const pluginsDir = (home: string) => join(home, ".claude", "plugins");

interface PluginInstall {
  id: string;
  name: string;
  root: string;
  /** Scope the plugin was installed at; project-scope installs come from the repo. */
  scope: "user" | "project" | "local";
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function mcpServersOf(block: unknown): Record<string, ServerConfig> {
  if (!block || typeof block !== "object" || Array.isArray(block)) return {};
  const out: Record<string, ServerConfig> = {};
  for (const [name, config] of Object.entries(block as Record<string, unknown>)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) continue;
    out[name] = config as ServerConfig;
  }
  return out;
}

/**
 * `~/.claude/plugins/installed_plugins.json` records every install under
 * `<plugin>@<marketplace>` with its `installPath` and `scope`. A plugin has one install
 * object or an array of them (one per scope); the shape is tolerated loosely.
 */
function readPluginInstalls(home: string, warnings: string[]): PluginInstall[] {
  const file = join(pluginsDir(home), "installed_plugins.json");
  const json = readJson(file, warnings);
  if (!json) return [];
  const records = (json.plugins ?? json) as Record<string, unknown>;
  const out: PluginInstall[] = [];
  for (const [id, value] of Object.entries(records)) {
    for (const raw of Array.isArray(value) ? value : [value]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const install = raw as Record<string, unknown>;
      const root = readString(install.installPath);
      if (!root) continue;
      const scope =
        install.scope === "project" || install.scope === "local" ? install.scope : "user";
      out.push({ id, name: id.split("@")[0] ?? id, root, scope });
    }
  }
  return out;
}

/** Servers from a plugin's `.mcp.json` plus inline `mcpServers` in its `.claude-plugin/plugin.json`. */
function pluginServers(install: PluginInstall, warnings: string[]): DiscoveredServer[] {
  const manifestFile = join(install.root, ".claude-plugin", "plugin.json");
  const manifest = readJson(manifestFile, warnings) ?? {};
  const name = readString(manifest.name) ?? install.name;
  const servers = new Map<string, { config: ServerConfig; file: string }>();
  const add = (block: unknown, file: string) => {
    for (const [server, config] of Object.entries(mcpServersOf(block))) {
      servers.set(server, { config, file });
    }
  };
  // Claude Code loads `.mcp.json` first, then the manifest's `mcpServers` on top.
  const mcpFile = join(install.root, ".mcp.json");
  add(readJson(mcpFile, warnings)?.mcpServers, mcpFile);
  add(manifest.mcpServers, manifestFile);
  return [...servers].map(([server, { config, file }]) => ({
    name: `plugin:${name}:${server}`,
    scope: "plugin" as const,
    config,
    file,
    ...(install.scope === "project" ? { requiresTrust: true } : {}),
  }));
}

/**
 * Servers from enabled plugins. Claude Code registers each one as
 * `plugin:<plugin>:<server>`, which normalizes to `mcp__plugin_<plugin>_<server>__<tool>`.
 */
function pluginScopeServers(opts: DiscoverOpts, warnings: string[]): DiscoveredServer[] {
  const enabled = enabledPlugins(opts.home, opts.project);
  if (enabled.length === 0) return [];
  const installs = readPluginInstalls(opts.home, warnings);
  const servers: DiscoveredServer[] = [];
  for (const id of enabled) {
    // Session-only and skills-directory plugins have no install record in this file.
    if (/@(inline|skills-dir|synced)$/.test(id)) continue;
    const install = installs.find((i) => i.id === id);
    if (!install) {
      warnings.push(
        `plugin ${id} is enabled in settings but has no install record in ${pluginsDir(opts.home)}; its MCP servers are not scanned`,
      );
      continue;
    }
    if (!existsSync(install.root)) {
      warnings.push(
        `plugin ${id} is installed at ${install.root}, which no longer exists; its MCP servers are not scanned`,
      );
      continue;
    }
    servers.push(...pluginServers(install, warnings));
  }
  return servers;
}

/**
 * Find MCP servers from user (~/.claude.json), local
 * (~/.claude.json projects[path]), project (.mcp.json) and installed plugin scopes.
 * Same-name precedence matches Claude Code: local > project > user > plugin.
 */
export function discoverServers(opts: DiscoverOpts): {
  servers: DiscoveredServer[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const claudeJson = join(opts.home, ".claude.json");
  const cj = readJson(claudeJson, warnings);
  const mcpJson = join(resolve(opts.project), ".mcp.json");
  const pj = readJson(mcpJson, warnings);

  const user = pick(cj?.mcpServers, "user", claudeJson);
  const projects = (cj?.projects ?? {}) as Record<string, { mcpServers?: unknown }>;
  const local = projectKeys(opts.project).flatMap((k) =>
    pick(projects[k]?.mcpServers, "local", claudeJson),
  );
  const proj = pick(pj?.mcpServers, "project", mcpJson);
  const plugin = pluginScopeServers(opts, warnings);

  const byName = new Map<string, DiscoveredServer>();
  for (const s of [...plugin, ...user, ...proj, ...local]) byName.set(s.name, s);
  return { servers: [...byName.values()], warnings };
}
