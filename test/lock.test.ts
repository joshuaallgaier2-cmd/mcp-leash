import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockCommand } from "../src/cmd-lock.js";
import { logCommand } from "../src/cmd-log.js";
import { unlockCommand } from "../src/cmd-unlock.js";
import type { Ctx } from "../src/paths.js";

let root: string;
let ctx: Ctx;
let proj: string;
let out: string[];
let err: string[];

const settingsFile = () => join(ctx.home, ".claude", "settings.json");
const stateFile = () => join(ctx.leashHome, "state.json");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const seed = (v: unknown) => {
  mkdirSync(join(ctx.home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(), `${JSON.stringify(v, null, 2)}\n`);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "leash-lock-")));
  const hookSource = join(root, "hook-src.mjs");
  writeFileSync(hookSource, "// stub hook\n");
  ctx = { home: join(root, "home"), leashHome: join(root, "leash"), hookSource };
  proj = join(root, "proj");
  mkdirSync(ctx.home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  // a github server: classified from presets with --offline, never spawned
  writeFileSync(
    join(proj, ".mcp.json"),
    JSON.stringify({ mcpServers: { github: { command: "npx", args: ["server-github"] } } }),
  );
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  try {
    chmodSync(join(ctx.home, ".claude"), 0o700);
  } catch {
    /* may not exist */
  }
  rmSync(root, { recursive: true, force: true });
});

const lock = (extra: string[] = [], deps = {}) =>
  lockCommand(["--yes", "--offline", "--project", proj, ...extra], ctx, deps);
const unlock = (extra: string[] = [], deps = {}) =>
  unlockCommand(["--yes", "--project", proj, ...extra], ctx, deps);

describe("lock ordering and rollback", () => {
  it("a corrupt state.json fails with a clear error before anything is changed", async () => {
    mkdirSync(ctx.leashHome, { recursive: true });
    writeFileSync(stateFile(), "{corrupt");
    const original = { model: "x" };
    seed(original);
    await expect(lock()).rejects.toThrow(/state\.json.*corrupt/);
    expect(read(settingsFile())).toEqual(original);
    expect(existsSync(join(ctx.leashHome, "hook.mjs"))).toBe(false);
    expect(readdirSync(join(ctx.home, ".claude"))).toEqual(["settings.json"]);
  });

  it("a missing hook source fails before settings or state are touched", async () => {
    seed({ model: "x" });
    const bad = { ...ctx, hookSource: join(root, "nope.mjs") };
    await expect(lockCommand(["--yes", "--offline", "--project", proj], bad)).rejects.toThrow(
      /hook\.mjs not found/,
    );
    expect(read(settingsFile())).toEqual({ model: "x" });
    expect(existsSync(stateFile())).toBe(false);
  });

  it("rolls the state back when the settings write fails", async () => {
    mkdirSync(join(ctx.home, ".claude"), { recursive: true });
    chmodSync(join(ctx.home, ".claude"), 0o500); // settings.json cannot be created
    await expect(lock()).rejects.toThrow();
    expect(existsSync(stateFile())).toBe(false);
  });

  it("records state for what it wrote (state first, then settings)", async () => {
    expect(await lock()).toBe(0);
    const state = read(stateFile());
    expect(state.files[settingsFile()].deny).toContain("mcp__github__merge_pull_request");
    expect(read(settingsFile()).permissions.deny).toContain("mcp__github__merge_pull_request");
  });
});

describe("concurrent edits", () => {
  it("lock re-reads the settings after the prompt and keeps edits made meanwhile", async () => {
    seed({ model: "sonnet" });
    const approveAfterEdit = async () => {
      seed({ model: "opus", theme: "dark", permissions: { allow: ["Bash(ls:*)"] } });
      return "yes" as const;
    };
    expect(
      await lockCommand(["--offline", "--project", proj], ctx, { approve: approveAfterEdit }),
    ).toBe(0);
    const s = read(settingsFile());
    expect(s.model).toBe("opus");
    expect(s.theme).toBe("dark");
    expect(s.permissions.allow).toEqual(["Bash(ls:*)"]);
    expect(s.permissions.deny).toContain("mcp__github__merge_pull_request");
  });

  it("unlock keeps edits made while the prompt was open", async () => {
    await lock();
    const approveAfterEdit = async () => {
      const s = read(settingsFile());
      s.model = "opus";
      writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
      return "yes" as const;
    };
    expect(await unlockCommand(["--project", proj], ctx, { approve: approveAfterEdit })).toBe(0);
    expect(read(settingsFile())).toEqual({ model: "opus" });
  });
});

describe("unlock with missing or symlinked settings", () => {
  it("does not create {} when the settings file is gone, and drops the stale record", async () => {
    await lock();
    rmSync(settingsFile());
    expect(await unlock()).toBe(0);
    expect(existsSync(settingsFile())).toBe(false);
    expect(read(stateFile()).files).toEqual({});
  });

  it("keys state on the realpath and leaves a symlinked settings.json a symlink", async () => {
    const real = join(root, "dotfiles", "settings.json");
    mkdirSync(join(root, "dotfiles"));
    writeFileSync(real, `${JSON.stringify({ model: "x" }, null, 2)}\n`);
    mkdirSync(join(ctx.home, ".claude"), { recursive: true });
    symlinkSync(real, settingsFile());

    await lock();
    expect(lstatSync(settingsFile()).isSymbolicLink()).toBe(true);
    expect(Object.keys(read(stateFile()).files)).toEqual([real]);
    expect(read(real).permissions.deny).toContain("mcp__github__merge_pull_request");

    await unlock();
    expect(lstatSync(settingsFile()).isSymbolicLink()).toBe(true);
    expect(read(real)).toEqual({ model: "x" });
  });
});

describe("lock output", () => {
  it("warns that --scope project hook paths are machine-specific", async () => {
    await lock(["--scope", "project"]);
    expect(err.join("\n")).toMatch(/machine-specific/);
  });

  it("does not warn for user scope", async () => {
    await lock();
    expect(err.join("\n")).not.toMatch(/machine-specific/);
  });

  it("lists added rules that override an existing allow rule", async () => {
    seed({ permissions: { allow: ["mcp__github__*"] } });
    await lock();
    expect(out.join("\n")).toMatch(/mcp__github__merge_pull_request.*overrides your allow/);
  });

  it("warns when an enabled plugin has no install record", async () => {
    seed({ enabledPlugins: { "p@m": true } });
    await lock();
    expect(err.join("\n")).toMatch(/p@m.*no install record/);
  });

  it("warns about nested-quantifier patterns in rules.json (lock and log)", async () => {
    mkdirSync(ctx.leashHome, { recursive: true });
    writeFileSync(
      join(ctx.leashHome, "rules.json"),
      JSON.stringify({ rules: [{ tool: "*", when: { a: "^(x+)+$" }, decision: "ask" }] }),
    );
    await lock();
    expect(err.join("\n")).toMatch(/\(x\+\)\+/);
    err.length = 0;
    await logCommand([], ctx);
    expect(err.join("\n")).toMatch(/\(x\+\)\+/);
  });

  it("writes the server list into a freshly created rules.json", async () => {
    await lock();
    expect(read(join(ctx.leashHome, "rules.json")).servers).toEqual(["github"]);
  });

  it("refuses non-array permissions without touching the file", async () => {
    seed({ permissions: { ask: "oops" } });
    const before = readFileSync(settingsFile(), "utf8");
    await expect(lock()).rejects.toThrow(/permissions\.ask/);
    expect(readFileSync(settingsFile(), "utf8")).toBe(before);
    expect(existsSync(stateFile())).toBe(false);
  });
});
