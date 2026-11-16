# mcp-leash spec (v0.1)

**One-liner:** Find the dangerous tools in your MCP servers and lock them down in Claude Code with one command.

**Install / run:** `npx mcp-leash` (no install needed). Permanent use: `npm i -g mcp-leash`.

## Verified Claude Code facts (code.claude.com/docs, 2026-11-14, Claude Code 2.1.250)
- MCP tool names are `mcp__<server>__<tool>`. Characters outside `[A-Za-z0-9_-]` in the server name become `_`. Plugin servers are named `mcp__plugin_<plugin>_<server>__<tool>`.
- Plugins: `~/.claude/plugins/installed_plugins.json` records each install (`scope`, `installPath`, `version`) under `<plugin>@<marketplace>`; `enabledPlugins` in a settings file decides whether it loads. A plugin's servers come from `.mcp.json` at the plugin root and inline `mcpServers` in `.claude-plugin/plugin.json`, registered as `plugin:<plugin>:<server>`. Precedence: local > project > user > plugin.
- MCP server configs:
  - `~/.claude.json` → `mcpServers` (user scope)
  - `~/.claude.json` → `projects[<abs path>].mcpServers` (local scope)
  - `<project>/.mcp.json` → `mcpServers` (project scope)
  - Entry shapes: stdio `{command,args,env}` (no `type` means stdio); `{type:"http"|"sse"|"ws", url, headers}`.
- Permission rules live in `settings.json` under `permissions.{allow,ask,deny}` (arrays of strings). Rules are checked in the order deny → ask → allow. The first match wins.
  - `mcp__server__tool` names one tool. `mcp__server__*` names every tool on a server.
  - **Claude Code skips any `mcp__` rule with parentheses**, so argument filtering MUST be done in a hook.
- Settings files:
  - user: `~/.claude/settings.json`
  - project: `<project>/.claude/settings.json`
  - local: `<project>/.claude/settings.local.json`
- PreToolUse hook registration:
  `{"hooks":{"PreToolUse":[{"matcher":"mcp__.*","hooks":[{"type":"command","command":"..."}]}]}}`.
  The matcher is a JS regex if it contains special characters.
  - Stdin JSON fields: `session_id, cwd, hook_event_name, tool_name, tool_input, tool_use_id, permission_mode, transcript_path`.
  - To decide, exit 0 and print `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny"|"ask","permissionDecisionReason":"..."}}`.
  - Exit 0 with no output means no decision (normal flow).
  - Exit 2 blocks the call, with stderr as the reason.
  - Any other non-zero exit is a non-blocking error.
- MCP tool annotations (from the MCP spec): `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.

## Commands

### `mcp-leash scan [--project <dir>] [--offline] [--json]`
1. Discover servers from the three settings scopes and from enabled plugins for the current project (default cwd). Show which scope each server comes from.
2. For each server, connect with `@modelcontextprotocol/sdk` (stdio spawn, or streamable HTTP with SSE fallback) and call `tools/list`.
   - Timeout is 10s per server.
   - Servers that need auth or fail are shown as `⚠ could not connect (reason)` and do not crash the scan.
   - Kill spawned processes afterwards.
   - `--offline` skips connecting and only uses presets.
   - Servers from a plugin installed at project scope are treated like project `.mcp.json` servers: they need `--trust-project`.
3. Classify each tool as one of four risks:
   - **critical**: irreversible or destructive. Examples: delete, remove, drop, destroy, purge, truncate, force-push, merge, or `destructiveHint:true`.
   - **write**: changes state or sends to the outside world. Examples: create, update, write, edit, push, send, post, publish, execute, run, exec, shell, query that mutates, transfer.
   - **read**: `readOnlyHint:true`, or a get/list/search/read/fetch/describe verb.
   - **unknown**: anything else.
   Classification order:
   1. Preset override for known servers.
   2. MCP annotations.
   3. Verb heuristics on the tool name split by `_`, `-` and camelCase. Description keywords are a weak tiebreaker.
   Each classification records the reason.
4. Print a coloured table grouped by server: risk badge, tool name, and a short reason.
   - Summary line: "N servers, M tools: X critical, Y write, Z read".
   - Show the existing status if rules already cover the tool: denied / ask / allowed (from the existing settings).
   - End with the next step: `Run: npx mcp-leash lock`.
5. `--json` prints machine-readable output. Exit code is 0.

### `mcp-leash lock [--scope user|project|local] [--level strict|balanced] [--yes] [--no-hook]`
- Default scope is `user` and default level is `balanced`.
- **balanced:** critical → `deny`, write → `ask`, read and unknown → untouched.
- **strict:** critical → `deny`, write and unknown → `ask`.
- Rules are full tool names. The tool list comes from a scan; with `--offline`, it uses presets only.
- Never removes or reorders existing user rules. Merges with dedupe. Does not add an `ask` rule if the tool already has a user `deny`.
- Before writing:
  - Show a diff of the rules being added.
  - Ask for confirmation, unless `--yes` is given or stdin is not a TTY. Without a TTY and without `--yes`, abort with a message.
  - Back up the original file to `<file>.mcp-leash.bak-<timestamp>`.
- Writes valid JSON, keeps other keys, and keeps 2-space indent.
- Unless `--no-hook`:
  - Copy the hook as a self-contained file (no deps) to `~/.mcp-leash/hook.mjs`.
  - Register a PreToolUse hook with matcher `mcp__.*` and command `node "<abs path>/hook.mjs"` in the same settings file.
  - Do it idempotently, so there is no duplicate if the hook is already registered.
- Record everything added in `~/.mcp-leash/state.json` (per settings file) so that unlock can remove exactly those entries.
- Explain that Claude Code must be restarted, or `/permissions` reloaded, for the rules to take effect.

### `mcp-leash unlock [--scope ...] [--yes]`
- Removes only the rules and hook entries recorded in `state.json` for that file.
- Takes a backup first, with the same confirm behaviour as lock.

### `mcp-leash hook` (internal; run by Claude Code via hook.mjs)
- Reads the PreToolUse JSON from stdin.
- Appends an audit line to `~/.mcp-leash/audit.jsonl`:
  - `{ts, session_id, cwd, tool_name, server, tool, args_preview (≤300 chars, secrets redacted), decision, rule}`.
  - Redact values whose keys match `/token|secret|password|key|auth/i`.
- Evaluates argument rules from `~/.mcp-leash/rules.json`. The first matching rule wins. Example rule:
  `{ "tool": "mcp__github__push_files", "when": {"branch": "^(main|master)$"}, "decision": "deny", "reason": "No direct pushes to main" }`.
  - `tool` is a glob with `*`.
  - `when` maps a top-level arg name to a regex, and every entry must match.
  - Supported `decision` values: `deny`, `ask`.
- `lock` writes default argument rules from presets if `rules.json` is absent. It never overwrites user edits.
- If no rule matches, print nothing and exit 0 (normal flow).
- **Fail-open:** on any internal error, write the error to stderr and exit 0 with no output. This never blocks the user's work by accident. `rules.json` `"failClosed": true` makes errors deny instead.
- Must finish in under 100ms. No network, no SDK import.

### `mcp-leash log [--today] [--server <name>] [--json] [-n 50]`
- Pretty table of recent audit entries: time, server, tool, decision.
- Summary: calls per server, and how many were denied or asked.

## Presets (`src/presets/*.ts`)
- Cover at least these servers:
  - **github:** `delete_*`, `merge_pull_request`, `push_files`, `create_or_update_file`, `fork`, and similar
  - **git:** `git_reset` → critical; commit/add/checkout/branch/merge → write
  - **filesystem**
  - **slack**
  - **postgres/sqlite/supabase:** `execute_sql`/`query` → write; drop → critical
  - **redis:** `flushall`/`flushdb`/`drop_*` → critical; `set`/`hset`/`delete`/`expire` → write; `get`/`hgetall`/`scan_keys`/`dbsize` → read
  - **mongodb:** `drop-*`/`delete-many` → critical; `insert-*`/`update-*`/`aggregate` → write; `find`/`count`/`list-*` → read
  - **stripe**
  - **notion**
  - **linear**
  - **puppeteer/playwright:** evaluate → write
  - **docker**
  - **kubernetes:** delete → critical; apply → write
  - **aws**
  - **shell/desktop-commander:** execute_command → critical
- A server matches a preset by server key or by command/url substring (for example `@modelcontextprotocol/server-github`, `github-mcp-server`, `api.githubcopilot.com/mcp`).
- Default argument rules:
  - github `push_files` / `create_or_update_file` to main or master → ask
  - filesystem write/edit/move to paths outside the session `cwd` → ask

## Tech
- TypeScript with ESM, Node ≥20.
- Libraries: `@modelcontextprotocol/sdk`, `picocolors`, plus a tiny argument parser (`node:util parseArgs`).
- Bundle with `tsup`:
  - `dist/cli.js` with a shebang
  - `dist/hook.mjs`, a standalone bundle with no runtime deps
- `package.json` `bin`: `{"mcp-leash": "dist/cli.js"}`. `files`: `dist`, `README`, `LICENSE`.
- Tests use vitest.
  - Unit tests: classifier, config discovery, settings merge/unmerge, hook decisions and redaction, and preset matching.
  - Integration test: a tiny fake stdio MCP server in `test/fixtures` exposing `read_thing`, `delete_thing` (`destructiveHint`) and `send_message`.
    - `scan` must find and classify all three.
    - `lock` must produce the correct settings in a temp HOME.
    - `unlock` must restore them.
  - Every file operation in tests uses a temp `HOME` / project dir. Never touch the real `~`.
- Paths: respect `HOME` from the environment (`os.homedir()`). Allow an `MCP_LEASH_HOME` override for tests.

## Repo hygiene (launch checklist items built in from day one)
- README top:
  - one-liner
  - `npx mcp-leash` command
  - GIF placeholder `docs/demo.gif`
  - badges for CI, npm and license
- Then "Why" (3 bullets), a 3-command quickstart, an example scan output, how it works, the rules.json reference, FAQ (fail-open? which clients?), and Uninstall.
- Other files:
  - `LICENSE` (MIT, copyright 2026 codersanjay3)
  - `CONTRIBUTING.md`
  - `CHANGELOG.md` (0.1.0)
  - `.github/ISSUE_TEMPLATE/{bug_report.yml,feature_request.yml,config.yml}` (config points questions to Discussions)
  - `.github/workflows/ci.yml` (Node 20/22/24 on ubuntu and macos, `npm ci && npm run lint && npm test && npm run build`)
  - `docs/good-first-issues.md` (5 drafted issues, e.g. new presets)
  - `docs/show-hn.md` (draft)
  - `SECURITY.md`
  - `.gitignore`
- `docs/social-preview.png` is made later.
- No secrets anywhere. `.gitignore` covers `.env*`.
