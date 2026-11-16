# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `log --since <duration>`: filter the audit log by a recent interval, for example 1h or 2d.
- `scan` and `lock` discover MCP servers provided by enabled plugins: installs are read from
  `~/.claude/plugins/installed_plugins.json`, servers from the plugin's `.mcp.json` and inline
  `mcpServers`, and they show as `plugin` scope with `mcp__plugin_<plugin>_<server>__<tool>` names.
  Plugin installs at project scope follow the `--trust-project` rule.
- Preset for the Git MCP server (`mcp-server-git`, `mcp/git`): `git_reset` is critical;
  `git_commit`, `git_add`, `git_checkout`, `git_create_branch` and `git_merge` are write;
  status, diff, log, show, branch and remote are read.
- Presets for Redis (`redis-mcp-server`, `mcp/redis`) and MongoDB (`mongodb-mcp-server`):
  `flushall`/`flushdb`/`drop_*` (MongoDB: `delete-many`) are critical; `set`, `hset`,
  `insert-*` and `update-*` are write; `get`, `find` and `list-*` are read.

## [0.1.0] - 2026-11-14

### Added
- `scan`: discovers MCP servers from user, local and project scope; connects over
  stdio, streamable HTTP (SSE fallback) with a 10s timeout; classifies every tool as
  critical / write / read / unknown with a reason; `--offline` and `--json`.
- `lock` / `unlock`: merge deny/ask permission rules into Claude Code settings
  (user, project or local scope; balanced or strict), with diff, confirmation, backup,
  idempotent hook registration and exact undo via `~/.mcp-leash/state.json`.
- `hook`: dependency-free PreToolUse hook (`dist/hook.mjs`) with argument rules from
  `rules.json`, redacted audit log and fail-open behaviour (`failClosed` opt-in).
- `log`: pretty or JSON view of the audit log.
- Browser playground at https://codersanjay3.github.io/mcp-leash/ that runs the same
  classifier and planner client-side.
- Presets for GitHub, filesystem, Slack, Postgres, SQLite, Supabase, Stripe, Notion,
  Linear, Puppeteer, Playwright, Docker, Kubernetes, AWS, shell and Desktop Commander.

### Requirements
- Node 20 or newer (Node 18 reached end of life in April 2025). CI tests Node 20, 22 and 24
  on Ubuntu and macOS.

### Security and robustness
- Project `.mcp.json` servers (stdio and remote) are only started or contacted with
  `--trust-project` or an interactive yes, so a cloned repo can't run commands or receive
  `${VAR}`-expanded secrets.
- Scanned servers run in their own process group and are killed with all their children; one
  10s deadline per server.
- Settings writes follow symlinks and keep the file mode; lock validates state and hook source
  before touching settings, re-reads settings after the prompt, and rolls state back on failure.
- Hook: per-rule error isolation, audit always attempted, 2048-char regex input cap, 800ms
  watchdog, broader redaction, audit log mode 0600.
- `scan`/`lock` warn about enabled plugins (their MCP servers are not covered yet).

[0.1.0]: https://github.com/codersanjay3/mcp-leash/releases/tag/v0.1.0
