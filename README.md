# dsh-mworks-ai

MWORKS AI for DeepSeek Harness — the same shape as the official **Syslab AI** and **Sysplorer AI** assistants: official MCP servers, official skills, and one place in the UI that reports what the agent can do.

## Install

Published on npm as [`dsh-mworks-ai`](https://www.npmjs.com/package/dsh-mworks-ai).

```bash
npm install --save-dev dsh-mworks-ai
```

The package declares `dsh.bundle.patch` (`cordis.patch.yml`) and `dsh.client`, so a harness that loads it as a bundle picks up both the MCP rows and the UI section with no extra wiring.

## What it adds

| Surface | What you get |
|---|---|
| Tools | `mcp__mworks_syslab__*` (8 tools: Julia execution, environment detection, help search, MATLAB→Julia mapping) and `mcp__mworks_sysplorer__*` (15 tools: session, library, model, check, translate, simulate, layout, results, plotting, API/model docs, resources). Plus `mworks_environment` (installation + live MCP state), `mworks_mcp_status`, and `mworks_mcp_restart`. |
| Instructions | The official MWORKS working rules: Syslab needs `read_syslab_skill` → `detect_syslab_toolboxes` before any code execution; prefer `Ty*` packages; confirm APIs from local help; call `session_manager` before other Sysplorer tools; keep outputs out of the installation directories. Plus the recovery rule: a MWORKS call that stops answering is not fixed by retrying — read `mworks_mcp_status` and rebuild the server instead. |
| UI | A **Runtime environment** section on this bundle's own page under **Plugins**, below the configuration the Plugin Manager draws. It lists the detected Syslab and Sysplorer installations and versions, the Julia runtime, both MCP servers with their live connection state, and the MWORKS skills this session can call, with **Re-detect** and, for a server that is not connected, **Reconnect**. The section renders nothing on any other plugin's page. Nothing is added to the conversation. |

## The two HTTP routes

The section reads `GET /api/dsh-mworks-ai/environment`; its **Reconnect** control posts to `POST /api/dsh-mworks-ai/restart`. Both are gated the way the Host's own routes are:

| Layer | What it stops |
|---|---|
| `ctx.connection.requestRejection(request)` | The Host's access check: a `Host` fence (loopback, the bind address or `trustedHosts`) that a rebinding page cannot forge, the cross-site and `Origin` fences, and the browser login cookie. Its `401`/`403` is written as-is, and its verdict is **final** — this plugin does not add a second opinion when the service is mounted, because it cannot see the deployment's `trustedHosts`. |
| Local same-origin test | Fallback for a profile that mounts no `connection` service. On its own it cannot see a bare browser read over plain HTTP, so it is never the only defence. |
| `application/json` required on `/restart` | A cross-site "simple request" can carry `text/plain` without a CORS preflight; anything else is `415` before the body is parsed. |

A guard that throws refuses rather than falling through.

## Why the MCP servers are owned by the MCP manager

`cordis.patch.yml` contains only this plugin's own row: the two servers are contributed at runtime through `ctx.mcpManager.register()`, not as bare `@deepseek-ai/dsh-mcp-client` rows. That buys two things a bare row cannot:

- **Observable state.** A server reports `connecting` / `connected` / `reconnecting` / `failed` with its registered tool count and last error, in the section and in `mworks_mcp_status`.
- **In-place recovery.** `mcpManager.restart(name)` remounts just that MCP child.

Both matter because of a failure mode that otherwise stays invisible: when Sysplorer is restarted underneath a running session, the MCP child keeps running but stays attached to the old engine port. It emits no close and no error, so the client bridge has nothing to reconnect on, and every subsequent call blocks until `toolCallTimeoutMs` (five minutes) expires. Killing/remounting the child is what re-runs engine discovery and re-attaches to the live port — verified by killing a wedged child and watching a fresh one attach to the new port.

## Skills

The MWORKS skills are **registered by this plugin from the copies inside the MWORKS installation** (`<Sysplorer>/Tools/sysplorer_mcp/resources/modeling_skills` and `<Syslab>/Tools/syslab-skills`), the same way a skill bundle registers its own `skills/` directory. That matters because the MWORKS installers also copy those bundles into an AI client's folder (`%USERPROFILE%\.config\opencode\skills` for OpenCode), and no DeepSeek Harness provider scans that path on its own — without an explicit contribution, the skills reach the catalog only when some other plugin happens to read that directory.

- **No dependency on OpenCode.** OpenCode need not be installed and its folder need not exist; the plugin reads the installation instead.
- **No interference.** The plugin writes nothing into any client's skill folder, and it fills a gap only: when the registry already resolves any MWORKS skill, it registers nothing, so it never duplicates or overrides another provider's decisions (including a per-skill disable list).
- **Only MWORKS skills are taken from shared folders.** Every bundle counts inside the installation directories; from a shared client directory such as OpenCode's, only names MWORKS owns (`ty-`, `syslab-`, `ta-`, `modelica-library-workflow`, `sysplorer-mds-docs`) are claimed.
- **Gap fill by name.** A skill the registry already resolves is left to whichever provider supplies it; only missing names are registered from the installation.
- **Opt out.** Set `registerSkills: false` on this plugin's row to stop the contribution entirely, for example when another provider manages the MWORKS skills and you want its per-skill filtering to win.
- **Names come from frontmatter.** Folded (`>-`) and literal (`|`) descriptions are parsed, and each registration carries a directory `resourceBase`, so a skill's `references/`, `templates/` and `tests/` resolve against the installed bundle.

The Runtime environment section and `mworks_environment` report what the registry actually resolves and say whether that answer came from the registry or from the on-disk scan.

## Configuration

Server definitions (command, args, env, cwd, timeouts, reconnect policy) live in the `SERVERS` table of `lib/index.js`. Defaults:

| Setting | Value | Why |
|---|---|---|
| `toolCallTimeoutMs` | 300000 | A model check, translation or simulation can legitimately take minutes. This is also the worst-case cost of a wedged call, so lower it if your simulations are short. |
| `startupTimeoutMs` | 60000 | Sysplorer's first attach can take a while. |
| `reconnect` | enabled, 500 ms → 5 s backoff, 10 attempts | Recovers a child that actually exits. It cannot see a *wedged* child, which is what `mworks_mcp_restart` is for. |

A profile must mount `@deepseek-ai/dsh-mcp-manager` (the Web and Desktop profiles do). Without it the plugin still loads, but contributes no MCP servers, and `mworks_environment` says the state cannot be reported or repaired.

## Requirements

- A local MWORKS installation. The plugin ships **no paths**: at load time it resolves each installation and derives the MCP command, args and working directory from what it found. A product that is not installed contributes no server, and the plugin still loads.
- The profile must mount `@deepseek-ai/dsh-skill` (every standard profile does) for the skills to reach the agent, and `@deepseek-ai/dsh-mcp-manager` for the MCP servers. Both are part of the Web and Desktop profiles.

## How the installation is found

Resolution is three steps, first hit wins:

| Step | Source |
|---|---|
| 1 | This row's config: `syslabRoot`, `sysplorerRoot`, `juliaRoot`, `workspace`, `registerSkills` |
| 2 | The environment: `MWORKS_HOME`, `MWORKS_SYSLAB_HOME`, `MWORKS_SYSPLORER_HOME`, `MWORKS_JULIA_HOME`, `MWORKS_WORKSPACE` (plus the products' own `SYSLAB_HOME` / `JULIA_ROOT`) |
| 3 | A directory scan for `<Syslab|Sysplorer> <release>` inside the usual install bases (`%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LOCALAPPDATA%`, the user profile, `<drive>\MWORKS`), newest release first; a directory only counts when the product's payload is present |

A Julia directory only counts when it really is a runtime (`bin/julia`, not a folder that merely resembles one — Syslab also keeps a `syslab-julia` data directory). The modeling workspace defaults to `~/.dsh-mworks-ai/workspace`, created on demand, so nothing is ever written into the installation directories.

## Startup parameters that matter

`cordis.patch.yml` inserts one row, this plugin's own; the two MCP servers are contributed at runtime (see above). Two flags cost a debugging session each:

| Where | Detail |
|---|---|
| Syslab args | `--syslab-display-mode=nodesktop` keeps Julia calls off an open Syslab desktop; `--syslab-root` is mandatory or the server panics. |
| Sysplorer entry | Start through `Tools/sysplorer_mcp/main.py`, the launcher that exports `MCP_DEPLOY_ROOT`. Starting the inner `main.py` breaks `resources_retrieval` while `tools/list` still looks healthy. |

## Checks

`test/` holds four checks that run without the app:

```bash
node test/host-check.mjs       # MCP registration, tools, routes, status mapping
node test/render-check.mjs     # renders the detail-page section
node test/class-check.mjs      # every class used is defined, every rule is used
node test/metadata-check.mjs   # display metadata and artwork limits
```

`host-check.mjs` pins the MCP-manager contract (including that Sysplorer starts through the launcher and Syslab runs `nodesktop`), and `render-check.mjs` is the one that matters for UI changes: it walks the real element tree and asserts the contract (only `plugins.detail.section`, null on foreign pages, no fetch before the page opens), so a component that throws — which makes the host blank the section — fails the check instead of shipping.

## Limits

- All MWORKS capability comes from the installed products. Without Syslab the Julia tools fail; without Sysplorer the Modelica tools fail. The section says which paths are missing instead of guessing.
- The plugin only reads paths and version files. It writes nothing into the MWORKS directories, and it never starts a GUI.
- The section reports installation state, not connection health: the tool counts are what the official servers declare (8 and 15), and calling a tool is the only proof that one answered. Run `mworks_environment`, or open this bundle's page under Plugins, to see what was detected.
- Turning the bundle off removes both MCP connections, the tool, the instructions and the button.

## Releasing

`package.json` holds the version; the git tag and the GitHub Release must match it (`v` prefix is stripped before comparing).

1. Bump `version` in `package.json` and `npm test`.
2. Commit, then tag and push:

   ```bash
   git tag -a v1.0.1 -m "dsh-mworks-ai 1.0.1"
   git push origin main --tags
   ```

3. Publish a GitHub Release for that tag. `.github/workflows/npm-publish.yml` runs on `release: published`: it verifies the tag against `package.json`, runs the checks, and publishes to npm (skipping versions that already exist).

Authentication prefers npm **Trusted Publishing** (OIDC, no secret) and falls back to the `NPM_TOKEN` repository secret, so a granular token works until the trusted publisher is configured.
