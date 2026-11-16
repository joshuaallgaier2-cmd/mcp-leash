import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fullToolName } from "./names.js";
import { anyCovers, planAdditions, type RuleSets, ruleCovers } from "./plan.js";
import type { Level, Risk, Scope } from "./types.js";

export { fullToolName, planAdditions, type RuleSets, ruleCovers };

export interface HookSpec {
  matcher: string;
  command: string;
}

export interface LockRecord {
  deny: string[];
  ask: string[];
  hook?: HookSpec;
}

export interface HookEntry {
  type?: string;
  command?: string;
  [k: string]: unknown;
}
export interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}
export interface Settings {
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[]; [k: string]: unknown };
  hooks?: { PreToolUse?: HookGroup[]; [k: string]: HookGroup[] | undefined };
  [k: string]: unknown;
}

export function settingsPathFor(scope: Scope, home: string, project: string): string {
  switch (scope) {
    case "user":
      return join(home, ".claude", "settings.json");
    case "project":
      return join(resolve(project), ".claude", "settings.json");
    case "local":
      return join(resolve(project), ".claude", "settings.local.json");
    case "plugin":
      // Plugins are configured by `enabledPlugins`, not by a settings file of their own.
      throw new Error("plugins do not have a settings file");
  }
}

/** Settings files that can hold `enabledPlugins`. */
const SETTINGS_SCOPES: Scope[] = ["user", "project", "local"];

/** Plugin ids (`<name>@<marketplace>`) enabled in any settings file that applies to this project. */
export function enabledPlugins(home: string, project: string): string[] {
  const ids = new Set<string>();
  for (const scope of SETTINGS_SCOPES) {
    try {
      const v = readSettingsFile(settingsPathFor(scope, home, project)).enabledPlugins;
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      for (const [id, on] of Object.entries(v)) if (on === true) ids.add(id);
    } catch {
      /* unreadable settings are skipped */
    }
  }
  return [...ids];
}

export function toolStatus(
  fullName: string,
  rules: RuleSets,
  server?: string,
): "denied" | "ask" | "allowed" | undefined {
  if (anyCovers(rules.deny, fullName, server)) return "denied";
  if (anyCovers(rules.ask, fullName, server)) return "ask";
  if (anyCovers(rules.allow, fullName, server)) return "allowed";
  return undefined;
}

/** Added deny/ask rules that take precedence over (shadow) an existing user allow rule. */
export function allowOverrides(
  adds: { deny: string[]; ask: string[] },
  existing: RuleSets,
): { tool: string; rule: string }[] {
  const out: { tool: string; rule: string }[] = [];
  for (const tool of [...adds.deny, ...adds.ask]) {
    const rule = existing.allow.find((r) => ruleCovers(r, tool));
    if (rule !== undefined) out.push({ tool, rule });
  }
  return out;
}

export function rulesOf(settings: Settings | undefined): RuleSets {
  const p = settings?.permissions;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return { deny: arr(p?.deny), ask: arr(p?.ask), allow: arr(p?.allow) };
}

export function combineRules(list: RuleSets[]): RuleSets {
  return {
    deny: list.flatMap((r) => r.deny),
    ask: list.flatMap((r) => r.ask),
    allow: list.flatMap((r) => r.allow),
  };
}

const hasCommand = (settings: Settings, command: string) =>
  (settings.hooks?.PreToolUse ?? []).some((g) =>
    (g.hooks ?? []).some((h) => h.command === command),
  );

/** Pure: returns a new settings object plus exactly what was added. */
export function mergeSettings(
  input: Settings,
  adds: { deny: string[]; ask: string[] },
  hook: HookSpec | undefined,
): { settings: Settings; added: LockRecord } {
  const settings = structuredClone(input) as Settings;
  const added: LockRecord = { deny: [], ask: [], hook: undefined };

  const perms: unknown = settings.permissions;
  if (
    perms !== undefined &&
    (perms === null || typeof perms !== "object" || Array.isArray(perms))
  ) {
    throw new Error("settings: `permissions` is not an object; refusing to modify it");
  }
  for (const key of ["deny", "ask"] as const) {
    const cur = settings.permissions?.[key];
    if (cur !== undefined && !Array.isArray(cur)) {
      throw new Error(`settings: permissions.${key} is not an array; refusing to modify it`);
    }
  }
  const hooksVal: unknown = settings.hooks;
  if (hooksVal !== undefined) {
    if (hooksVal === null || typeof hooksVal !== "object" || Array.isArray(hooksVal)) {
      throw new Error("settings: `hooks` is not an object; refusing to modify it");
    }
    const pre = settings.hooks?.PreToolUse;
    if (pre !== undefined && !Array.isArray(pre)) {
      throw new Error("settings: hooks.PreToolUse is not an array; refusing to modify it");
    }
  }

  for (const key of ["deny", "ask"] as const) {
    const fresh = adds[key].filter((r) => !(settings.permissions?.[key] ?? []).includes(r));
    if (fresh.length === 0) continue;
    settings.permissions ??= {};
    settings.permissions[key] = [...(settings.permissions[key] ?? []), ...fresh];
    added[key] = fresh;
  }

  if (hook && !hasCommand(settings, hook.command)) {
    settings.hooks ??= {};
    settings.hooks.PreToolUse = [
      ...(settings.hooks.PreToolUse ?? []),
      { matcher: hook.matcher, hooks: [{ type: "command", command: hook.command }] },
    ];
    added.hook = hook;
  }
  return { settings, added };
}

/** Pure: remove exactly the recorded entries, pruning containers we emptied. */
export function unmergeSettings(input: Settings, record: LockRecord): Settings {
  const settings = structuredClone(input) as Settings;
  const perms = settings.permissions;
  if (perms) {
    for (const key of ["deny", "ask"] as const) {
      const cur = perms[key];
      if (!Array.isArray(cur)) continue;
      const next = cur.filter((r) => !record[key].includes(r));
      if (next.length === cur.length) continue;
      if (next.length) perms[key] = next;
      else delete perms[key];
    }
    if (Object.keys(perms).length === 0) delete settings.permissions;
  }

  const pre = settings.hooks?.PreToolUse;
  if (record.hook && Array.isArray(pre)) {
    const groups: HookGroup[] = [];
    for (const g of pre) {
      const hooks = g.hooks ?? [];
      const kept = hooks.filter((h) => h.command !== record.hook?.command);
      if (kept.length === hooks.length) groups.push(g);
      else if (kept.length) groups.push({ ...g, hooks: kept });
    }
    if (settings.hooks) {
      if (groups.length) settings.hooks.PreToolUse = groups;
      else delete settings.hooks.PreToolUse;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
  }
  return settings;
}

export function mergeRecords(a: LockRecord, b: LockRecord): LockRecord {
  const uniq = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return { deny: uniq(a.deny, b.deny), ask: uniq(a.ask, b.ask), hook: a.hook ?? b.hook };
}

export const isEmptyRecord = (r: LockRecord) =>
  r.deny.length === 0 && r.ask.length === 0 && !r.hook;

// ---------- file helpers ----------

/** Read a JSON object file. Missing -> {}. Invalid JSON throws (we never clobber it). */
export function readSettingsFile(path: string): Settings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  if (text.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message}); refusing to modify it`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${path} is not a JSON object; refusing to modify it`);
  }
  return v as Settings;
}

export function backupFile(path: string, now = new Date()): string | undefined {
  if (!existsSync(path)) return undefined;
  const ts = now.toISOString().replace(/[:.]/g, "-");
  let dest = `${path}.mcp-leash.bak-${ts}`;
  let n = 1;
  while (existsSync(dest)) dest = `${path}.mcp-leash.bak-${ts}-${n++}`;
  copyFileSync(path, dest);
  return dest;
}

/** The real path of `path` when it exists (resolves symlinks), else `path` unchanged. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Atomically write JSON. Follows symlinks (the temp file is created next to the real file and
 * renamed onto it, so a symlinked settings.json stays a symlink) and keeps the original file
 * mode. New files are created private (0600).
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const target = canonicalPath(path);
  mkdirSync(dirname(target), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch {
    /* new file */
  }
  const tmp = `${target}.mcp-leash.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(tmp, mode); // writeFileSync's mode is filtered by the umask
  renameSync(tmp, target);
}
