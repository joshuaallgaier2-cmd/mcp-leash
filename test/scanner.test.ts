import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runScan } from "../src/common.js";
import { discoverServers } from "../src/discovery.js";
import { makeCtx } from "../src/paths.js";
import { fetchTools, NOT_STARTED_NOTE, needsTrust, scanServer } from "../src/scanner.js";
import type { DiscoveredServer } from "../src/types.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE = join(FIX, "fake-server.mjs");
const SLOW = join(FIX, "slow-server.mjs");

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "leash-scanner-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitGone = async (pid: number, ms = 3000) => {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

describe("process cleanup and deadline", () => {
  it("kills grandchildren (sh -c 'sleep 300 & exec server') after a successful scan", async () => {
    const pidfile = join(root, "gc.pid");
    const tools = await fetchTools(
      {
        command: "sh",
        args: ["-c", `sleep 300 & echo $! > "$0"; exec node "${FAKE}"`, pidfile],
      },
      { cwd: root },
    );
    expect(tools.map((t) => t.name).sort()).toEqual(["delete_thing", "read_thing", "send_message"]);
    const pid = Number(readFileSync(pidfile, "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    expect(await waitGone(pid)).toBe(true);
  });

  it("kills grandchildren when the server never answers (timeout)", async () => {
    const pidfile = join(root, "gc2.pid");
    await expect(
      fetchTools(
        { command: "sh", args: ["-c", `sleep 300 & echo $! > "$0"; wait`, pidfile] },
        { cwd: root, timeoutMs: 800 },
      ),
    ).rejects.toThrow(/timed out/);
    const pid = Number(readFileSync(pidfile, "utf8").trim());
    expect(await waitGone(pid)).toBe(true);
  });

  it("uses one overall deadline per server, not one per step", async () => {
    // initialize takes 1s and tools/list takes 1s: each step fits in 1.5s, the total does not.
    const t0 = Date.now();
    await expect(
      fetchTools(
        { command: "node", args: [SLOW], env: { LEASH_DELAY_MS: "1000" } },
        { cwd: root, timeoutMs: 1500 },
      ),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(2800);
  });
});

describe("project-scope servers are not spawned without trust", () => {
  const marker = () => join(root, "marker");
  const server = (scope: DiscoveredServer["scope"]): DiscoveredServer => ({
    name: "evil",
    scope,
    file: join(root, ".mcp.json"),
    config: { command: "sh", args: ["-c", `touch "${marker()}"; exec node "${FAKE}"`] },
  });

  it("classifies via presets only, never starts the process, and notes why", async () => {
    const r = await scanServer(server("project"), { offline: false, cwd: root });
    expect(existsSync(marker())).toBe(false);
    expect(r.tools).toEqual([]);
    expect(r.error).toBeUndefined();
    expect(r.note).toBe("(not started: project server — rerun with --trust-project)");
  });

  it("does not contact remote project servers either (env vars in URL/headers could leak)", async () => {
    let hits = 0;
    const { createServer } = await import("node:http");
    const srv = createServer((_req, res) => {
      hits++;
      res.statusCode = 500;
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const remote: DiscoveredServer = {
        name: "evil-remote",
        scope: "project",
        file: join(root, ".mcp.json"),
        config: {
          type: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: "Bearer ${SECRET}" },
        },
      };
      const r = await scanServer(remote, { offline: false, cwd: root });
      expect(hits).toBe(0);
      expect(r.note).toBe(NOT_STARTED_NOTE);
    } finally {
      srv.close();
    }
  });

  it("still uses presets for a known project server", async () => {
    const gh: DiscoveredServer = {
      name: "github",
      scope: "project",
      file: "x",
      config: { command: "touch", args: [marker()] },
    };
    const r = await scanServer(gh, { offline: false, cwd: root });
    expect(existsSync(marker())).toBe(false);
    expect(r.source).toBe("preset");
    expect(r.tools.length).toBeGreaterThan(0);
  });

  it("spawns with trustProject", async () => {
    const r = await scanServer(server("project"), {
      offline: false,
      cwd: root,
      trustProject: true,
    });
    expect(existsSync(marker())).toBe(true);
    expect(r.tools).toHaveLength(3);
    expect(r.note).toBeUndefined();
  });

  it("spawns user- and local-scope servers as before", async () => {
    for (const scope of ["user", "local"] as const) {
      rmSync(marker(), { force: true });
      const r = await scanServer(server(scope), { offline: false, cwd: root });
      expect(existsSync(marker())).toBe(true);
      expect(r.tools).toHaveLength(3);
    }
  });
});

describe("runScan trust handling and plugin warning", () => {
  let home: string;
  let proj: string;
  beforeEach(() => {
    home = join(root, "home");
    proj = join(root, "proj");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          evil: { command: "sh", args: ["-c", `touch "${join(root, "m")}"; exec node "${FAKE}"`] },
        },
      }),
    );
  });
  const ctx = () => makeCtx({ HOME: home, MCP_LEASH_HOME: join(root, "leash") });

  it("does not prompt or spawn when not interactive", async () => {
    const r = await runScan(ctx(), { project: proj, offline: false, interactive: false });
    expect(existsSync(join(root, "m"))).toBe(false);
    expect(r.servers[0]?.note).toMatch(/--trust-project/);
  });

  it("asks in an interactive session and spawns on yes", async () => {
    let asked = "";
    const r = await runScan(ctx(), {
      project: proj,
      offline: false,
      interactive: true,
      confirmFn: async (q) => {
        asked = q;
        return true;
      },
    });
    expect(asked).toMatch(/evil/);
    expect(existsSync(join(root, "m"))).toBe(true);
    expect(r.servers[0]?.tools).toHaveLength(3);
  });

  it("asks in an interactive session and does not spawn on no", async () => {
    const r = await runScan(ctx(), {
      project: proj,
      offline: false,
      interactive: true,
      confirmFn: async () => false,
    });
    expect(existsSync(join(root, "m"))).toBe(false);
    expect(r.servers[0]?.note).toBeDefined();
  });

  it("--trust-project spawns without asking", async () => {
    await runScan(ctx(), {
      project: proj,
      offline: false,
      trustProject: true,
      interactive: true,
      confirmFn: async () => {
        throw new Error("should not ask");
      },
    });
    expect(existsSync(join(root, "m"))).toBe(true);
  });

  it("warns when an enabled plugin has no install record", async () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "foo@market": true, "off@market": false } }),
    );
    const r = await runScan(ctx(), { project: proj, offline: true });
    const w = r.warnings.find((x) => x.includes("foo@market"));
    expect(w).toMatch(/no install record/);
    expect(w).not.toContain("off@market");
  });

  it("no plugin warning when no plugins are enabled", async () => {
    const r = await runScan(ctx(), { project: proj, offline: true });
    expect(r.warnings).toEqual([]);
  });
});

describe("plugin-provided servers", () => {
  const setupPlugin = (scope: "user" | "project") => {
    const home = join(root, "home");
    const proj = join(root, "proj");
    const pluginRoot = join(home, ".claude", "plugins", "cache", "market", "demo", "1.0.0");
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "demo" }),
    );
    writeFileSync(
      join(pluginRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { fake: { command: "node", args: [FAKE] } } }),
    );
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "demo@market": [{ scope, installPath: pluginRoot, version: "1.0.0" }] },
      }),
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "demo@market": true } }),
    );
    return { home, proj };
  };

  it("lists an enabled plugin server in a scan", async () => {
    const { home, proj } = setupPlugin("user");
    const ctx = makeCtx({ HOME: home, MCP_LEASH_HOME: join(root, "leash") });
    const r = await runScan(ctx, { project: proj, offline: true });
    const s = r.servers.find((x) => x.name === "plugin:demo:fake");
    expect(s?.scope).toBe("plugin");
    expect(s?.target).toContain("fake-server.mjs");
  });

  it("names plugin tools mcp__plugin_<plugin>_<server>__<tool>", async () => {
    const { home, proj } = setupPlugin("user");
    const server = discoverServers({ home, project: proj }).servers.find(
      (x) => x.name === "plugin:demo:fake",
    );
    if (!server) throw new Error("plugin server not discovered");
    const s = await scanServer(server, { offline: false, cwd: proj, timeoutMs: 30_000 });
    expect(s.tools.map((t) => t.fullName).sort()).toEqual([
      "mcp__plugin_demo_fake__delete_thing",
      "mcp__plugin_demo_fake__read_thing",
      "mcp__plugin_demo_fake__send_message",
    ]);
  });

  it("does not start a project-scope plugin install without --trust-project", async () => {
    const { home, proj } = setupPlugin("project");
    const ctx = makeCtx({ HOME: home, MCP_LEASH_HOME: join(root, "leash") });
    const r = await runScan(ctx, { project: proj, offline: false, interactive: false });
    const s = r.servers.find((x) => x.name === "plugin:demo:fake");
    expect(s?.tools).toEqual([]);
    expect(s?.note).toMatch(/--trust-project/);
  });

  it("needsTrust covers project-scope plugin installs", () => {
    expect(
      needsTrust({
        name: "plugin:a:b",
        scope: "plugin",
        config: {},
        file: "x",
        requiresTrust: true,
      }),
    ).toBe(true);
    expect(needsTrust({ name: "plugin:a:b", scope: "plugin", config: {}, file: "x" })).toBe(false);
  });
});
