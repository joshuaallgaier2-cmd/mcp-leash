import { normalizeServerName } from "../names.js";
import type { ArgRule, ServerConfig } from "../types.js";
import { filesystem } from "./filesystem.js";
import { git } from "./git.js";
import { github } from "./github.js";
import {
  aws,
  desktopCommander,
  docker,
  kubernetes,
  linear,
  mongodb,
  notion,
  playwright,
  postgres,
  puppeteer,
  redis,
  shell,
  slack,
  sqlite,
  stripe,
  supabase,
} from "./others.js";
import type { Preset, PresetRisk } from "./types.js";

export type { Preset } from "./types.js";

// desktop-commander before shell, and github before git, so the more specific hints win.
export const PRESETS: Preset[] = [
  desktopCommander,
  github,
  git,
  filesystem,
  slack,
  supabase,
  postgres,
  sqlite,
  redis,
  mongodb,
  stripe,
  notion,
  linear,
  puppeteer,
  playwright,
  docker,
  kubernetes,
  aws,
  shell,
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function keyMatches(name: string, key: string): boolean {
  // Plugin servers arrive as `plugin:<plugin>:<server>`, so treat `:` as a separator too.
  const n = name.toLowerCase().replace(/[_.: ]+/g, "-");
  return new RegExp(`(^|-)${escapeRe(key)}(-|$)`).test(n);
}

/** Match by server key (word boundary) or by command/args/url substring. */
export function matchPreset(name: string, config: ServerConfig): Preset | undefined {
  const hay = [config.command ?? "", ...(config.args ?? []), config.url ?? ""]
    .join(" ")
    .toLowerCase();
  for (const p of PRESETS) {
    if (p.keys.some((k) => keyMatches(name, k))) return p;
  }
  for (const p of PRESETS) {
    if (p.hints.some((h) => hay.includes(h))) return p;
  }
  return undefined;
}

const globRe = (g: string) => new RegExp(`^${g.split("*").map(escapeRe).join(".*")}$`);

/** Exact entries first, then globs (critical, write, read). */
export function lookupPresetTool(
  preset: Preset,
  tool: string,
): { risk: PresetRisk; pattern: string } | undefined {
  const lists: [PresetRisk, string[]][] = [
    ["critical", preset.critical ?? []],
    ["write", preset.write ?? []],
    ["read", preset.read ?? []],
  ];
  for (const [risk, names] of lists) {
    if (names.includes(tool)) return { risk, pattern: tool };
  }
  for (const [risk, names] of lists) {
    const g = names.find((n) => n.includes("*") && globRe(n).test(tool));
    if (g) return { risk, pattern: g };
  }
  return undefined;
}

/** Tool names (no globs) to use when scanning offline. */
export function presetOfflineTools(preset: Preset): string[] {
  const all = [...(preset.critical ?? []), ...(preset.write ?? []), ...(preset.read ?? [])];
  return [...new Set(all.filter((n) => !n.includes("*")))];
}

export function defaultRulesFor(preset: Preset, serverName: string): ArgRule[] {
  const server = normalizeServerName(serverName);
  return (preset.rules ?? []).map((r) => ({
    ...r,
    tool: r.tool.replaceAll("{server}", server),
    ...(r.when ? { when: { ...r.when } } : {}),
  }));
}
