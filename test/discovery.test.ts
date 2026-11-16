import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverServers, normalizeServerName, transportOf } from "../src/discovery.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "plugin-demo");

let root: string;
let home: string;
let project: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "leash-disc-")));
  home = join(root, "home");
  project = join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));

describe("discoverServers BOM", () => {
  it("parses a config that starts with a UTF-8 BOM", () => {
    writeFileSync(
      join(home, ".claude.json"),
      `\uFEFF${JSON.stringify({ mcpServers: { a: { command: "x" } } })}`,
    );
    const { servers, warnings } = discoverServers({ home, project });
    expect(warnings).toEqual([]);
    expect(servers.map((s) => s.name)).toEqual(["a"]);
  });
});

describe("discoverServers", () => {
  it("reads user scope from ~/.claude.json mcpServers", () => {
    writeJson(join(home, ".claude.json"), {
      mcpServers: { a: { command: "node", args: ["a.js"] } },
    });
    const { servers } = discoverServers({ home, project });
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "a", scope: "user" });
    expect(servers[0]?.file).toBe(join(home, ".claude.json"));
  });

  it("reads local scope from ~/.claude.json projects[<abs path>].mcpServers", () => {
    writeJson(join(home, ".claude.json"), {
      projects: {
        [project]: { mcpServers: { b: { type: "http", url: "https://x.test/mcp" } } },
        "/some/other": { mcpServers: { nope: { command: "x" } } },
      },
    });
    const { servers } = discoverServers({ home, project });
    expect(servers.map((s) => s.name)).toEqual(["b"]);
    expect(servers[0]?.scope).toBe("local");
  });

  it("reads project scope from <project>/.mcp.json", () => {
    writeJson(join(project, ".mcp.json"), { mcpServers: { c: { command: "npx", args: ["c"] } } });
    const { servers } = discoverServers({ home, project });
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "c", scope: "project" });
  });

  it("applies precedence local > project > user for same-named servers", () => {
    writeJson(join(home, ".claude.json"), {
      mcpServers: { dup: { command: "user" }, only_user: { command: "u" } },
      projects: { [project]: { mcpServers: { dup: { command: "local" } } } },
    });
    writeJson(join(project, ".mcp.json"), {
      mcpServers: { dup: { command: "project" }, p2: { command: "p" } },
    });
    const { servers } = discoverServers({ home, project });
    const dup = servers.find((s) => s.name === "dup");
    expect(dup?.scope).toBe("local");
    expect(dup?.config.command).toBe("local");
    expect(servers.map((s) => s.name).sort()).toEqual(["dup", "only_user", "p2"]);
  });

  it("returns nothing (no throw) when no config exists", () => {
    expect(discoverServers({ home, project })).toEqual({ servers: [], warnings: [] });
  });

  it("warns on invalid JSON instead of crashing", () => {
    writeFileSync(join(project, ".mcp.json"), "{ not json");
    const r = discoverServers({ home, project });
    expect(r.servers).toEqual([]);
    expect(r.warnings[0]).toMatch(/\.mcp\.json/);
  });

  it("ignores malformed server entries", () => {
    writeJson(join(project, ".mcp.json"), { mcpServers: { bad: "nope", ok: { command: "x" } } });
    expect(discoverServers({ home, project }).servers.map((s) => s.name)).toEqual(["ok"]);
  });

  it("never reads outside the supplied home", () => {
    // sanity: an empty temp home yields nothing even if a real ~/.claude.json exists
    expect(discoverServers({ home, project }).servers).toEqual([]);
  });
});

describe("discoverServers plugins", () => {
  const pluginsRoot = () => join(home, ".claude", "plugins");

  /** Install the fixture plugin the way Claude Code would and enable it. */
  const install = (scope: "user" | "project" | "local" = "user") => {
    const root = join(pluginsRoot(), "cache", "market", "demo", "1.0.0");
    mkdirSync(dirname(root), { recursive: true });
    cpSync(FIX, root, { recursive: true });
    writeJson(join(pluginsRoot(), "installed_plugins.json"), {
      version: 2,
      plugins: { "demo@market": [{ scope, installPath: root, version: "1.0.0" }] },
    });
    writeJson(join(home, ".claude", "settings.json"), { enabledPlugins: { "demo@market": true } });
    return root;
  };

  it("reads .mcp.json and inline manifest servers as plugin:<plugin>:<server>", () => {
    const root = install();
    const { servers, warnings } = discoverServers({ home, project });
    expect(warnings).toEqual([]);
    expect(servers.map((s) => s.name).sort()).toEqual([
      "plugin:demo-plugin:inline-tools",
      "plugin:demo-plugin:plugin-files",
      "plugin:demo-plugin:remote",
    ]);
    expect(servers.every((s) => s.scope === "plugin")).toBe(true);
    expect(servers.find((s) => s.name === "plugin:demo-plugin:plugin-files")?.file).toBe(
      join(root, ".mcp.json"),
    );
    expect(servers.find((s) => s.name === "plugin:demo-plugin:inline-tools")?.config).toMatchObject(
      { command: "node", args: ["inline.mjs"] },
    );
    expect(servers.find((s) => s.name === "plugin:demo-plugin:remote")?.config).toMatchObject({
      type: "http",
      url: "https://example.test/mcp",
    });
  });

  it("ignores plugins that are not enabled", () => {
    install();
    writeJson(join(home, ".claude", "settings.json"), {
      enabledPlugins: { "demo@market": false },
    });
    expect(discoverServers({ home, project }).servers).toEqual([]);
  });

  it("warns about an enabled plugin with no install record", () => {
    mkdirSync(pluginsRoot(), { recursive: true });
    writeJson(join(pluginsRoot(), "installed_plugins.json"), { version: 2, plugins: {} });
    writeJson(join(home, ".claude", "settings.json"), { enabledPlugins: { "ghost@market": true } });
    const { servers, warnings } = discoverServers({ home, project });
    expect(servers).toEqual([]);
    expect(warnings[0]).toMatch(/ghost@market.*no install record/);
  });

  it("marks a project-scope install as needing trust", () => {
    install("project");
    const { servers } = discoverServers({ home, project });
    expect(servers).toHaveLength(3);
    expect(servers.every((s) => s.requiresTrust === true)).toBe(true);
  });

  it("leaves session-only and skills-directory plugins alone", () => {
    mkdirSync(pluginsRoot(), { recursive: true });
    writeJson(join(home, ".claude", "settings.json"), {
      enabledPlugins: { "solo@inline": true, "local@skills-dir": true },
    });
    const { servers, warnings } = discoverServers({ home, project });
    expect(servers).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("normalizeServerName / transportOf", () => {
  it("replaces chars outside [A-Za-z0-9_-] with _", () => {
    expect(normalizeServerName("my.server name")).toBe("my_server_name");
    expect(normalizeServerName("ok-name_1")).toBe("ok-name_1");
  });

  it("infers transport", () => {
    expect(transportOf({ command: "x" })).toBe("stdio");
    expect(transportOf({ type: "stdio", command: "x" })).toBe("stdio");
    expect(transportOf({ type: "http", url: "u" })).toBe("http");
    expect(transportOf({ type: "sse", url: "u" })).toBe("sse");
    expect(transportOf({ type: "ws", url: "u" })).toBe("ws");
    expect(transportOf({ url: "u" })).toBe("http");
  });
});
