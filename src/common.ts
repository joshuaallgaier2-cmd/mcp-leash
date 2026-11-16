import { createInterface } from "node:readline";
import { discoverServers } from "./discovery.js";
import type { Ctx } from "./paths.js";
import { describeTarget, needsTrust, type ScannedServer, scanAll } from "./scanner.js";
import {
  combineRules,
  type RuleSets,
  readSettingsFile,
  rulesOf,
  type Settings,
  settingsPathFor,
} from "./settings.js";
import type { DiscoveredServer, Scope } from "./types.js";

export const SCOPES: Scope[] = ["user", "project", "local"];

export interface ScanResult {
  project: string;
  discovered: DiscoveredServer[];
  servers: ScannedServer[];
  warnings: string[];
}

export interface ScanOpts {
  project: string;
  offline: boolean;
  /** Start project-scope (.mcp.json) stdio servers without asking. */
  trustProject?: boolean;
  /** Override TTY detection (tests). Defaults to stdin and stdout both being a TTY. */
  interactive?: boolean;
  confirmFn?: (question: string) => Promise<boolean>;
}

export async function runScan(ctx: Ctx, opts: ScanOpts): Promise<ScanResult> {
  const { servers: discovered, warnings } = discoverServers({
    home: ctx.home,
    project: opts.project,
  });

  let trustProject = opts.trustProject === true;
  if (!trustProject && !opts.offline) {
    const untrusted = discovered.filter(needsTrust);
    const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (untrusted.length > 0 && interactive) {
      const list = untrusted.map((s) => `  ${s.name}: ${describeTarget(s.config)}`).join("\n");
      const ask = opts.confirmFn ?? ((q: string) => confirm(q, process.stderr));
      trustProject = await ask(
        `The project .mcp.json defines servers that would run these commands on this machine:\n${list}\nStart them?`,
      );
    }
  }

  const servers = await scanAll(discovered, {
    offline: opts.offline,
    cwd: opts.project,
    trustProject,
  });

  return { project: opts.project, discovered, servers, warnings };
}

/** Rules from every settings file that applies to this project (unreadable files are skipped). */
export function existingRules(ctx: Ctx, project: string): RuleSets {
  const list: RuleSets[] = [];
  for (const scope of SCOPES) {
    try {
      const s: Settings = readSettingsFile(settingsPathFor(scope, ctx.home, project));
      list.push(rulesOf(s));
    } catch {
      /* ignore: scan must not fail on a broken settings file */
    }
  }
  return combineRules(list);
}

export function isScope(v: string): v is Scope {
  return (SCOPES as string[]).includes(v);
}

export async function confirm(
  question: string,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output });
  return new Promise((res) => {
    rl.question(`${question} [y/N] `, (a) => {
      rl.close();
      res(/^y(es)?$/i.test(a.trim()));
    });
  });
}

/**
 * Decide whether we may write. `--yes` -> yes. No TTY and no --yes -> abort.
 * Otherwise ask.
 */
export async function approve(opts: {
  yes: boolean;
  question: string;
}): Promise<"yes" | "no" | "no-tty"> {
  if (opts.yes) return "yes";
  if (!process.stdin.isTTY) return "no-tty";
  return (await confirm(opts.question)) ? "yes" : "no";
}
