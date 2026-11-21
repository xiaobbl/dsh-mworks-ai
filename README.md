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

## Why the MCP servers are owned by the MCP manager

`cordis.patch.yml` contains only this plugin's own row: the two servers are contributed at runtime through `ctx.mcpManager.register()`, not as bare `@deepseek-ai/dsh-mcp-client` rows. That buys two things a bare row cannot:

- **Observable state.** A server reports `connecting` / `connected` / `reconnecting` / `failed` with its registered tool count and last error, in the section and in `mworks_mcp_status`.
- **In-place recovery.** `mcpManager.restart(name)` remounts just that MCP child.

Both matter because of a failure mode that otherwise stays invisible: when Sysplorer is restarted underneath a running session, the MCP child keeps running but stays attached to the old engine port. It emits no close and no error, so the client bridge has nothing to reconnect on, and every subsequent call blocks until `toolCallTimeoutMs` (five minutes) expires. Killing/remounting the child is what re-runs engine discovery and re-attaches to the live port — verified by killing a wedged child and watching a fresh one attach to the new port.

## Configuration

Server definitions (command, args, env, cwd, timeouts, reconnect policy) live in the `SERVERS` table of `lib/index.js`. Defaults:

| Setting | Value | Why |
|---|---|---|
| `toolCallTimeoutMs` | 300000 | A model check, translation or simulation can legitimately take minutes. This is also the worst-case cost of a wedged call, so lower it if your simulations are short. |
| `startupTimeoutMs` | 60000 | Sysplorer's first attach can take a while. |
| `reconnect` | enabled, 500 ms → 5 s backoff, 10 attempts | Recovers a child that actually exits. It cannot see a *wedged* child, which is what `mworks_mcp_restart` is for. |

A profile must mount `@deepseek-ai/dsh-mcp-manager` (the Web and Desktop profiles do). Without it the plugin still loads, but contributes no MCP servers, and `mworks_environment` says the state cannot be reported or repaired.

## Requirements

- A local MWORKS installation. The patch is written for this machine:
  - Syslab `E:\MWORKS\Syslab 2026b`
  - Sysplorer `E:\MWORKS\Sysplorer 2026b`
  - Julia `C:\Users\Public\TongYuan\julia-1.10.10`

  Edit `cordis.patch.yml` if MWORKS lives elsewhere; the Runtime environment section and `mworks_environment` report what is actually found.
- The MWORKS skills you want the agent to follow, installed into a skill root the Harness scans (for example `~/.config/opencode/skills`, where the MWORKS installers put them).

## Configuration

`cordis.patch.yml` inserts three rows:

| Row | Role |
|---|---|
| `mcp-mworks-syslab` | `@deepseek-ai/dsh-mcp-client` → `syslab-mcp-server-win64.exe` over stdio. `--syslab-display-mode=nodesktop` keeps Julia calls off your open Syslab desktop; `--syslab-root` is mandatory or the server panics. |
| `mcp-mworks-sysplorer` | `@deepseek-ai/dsh-mcp-client` → Sysplorer's bundled `python.exe` running `Tools/sysplorer_mcp/main.py`. Start through that launcher: it exports `MCP_DEPLOY_ROOT`, and starting the inner `main.py` breaks `resources_retrieval` while `tools/list` still looks healthy. |
| `dsh-mworks-ai` | This bundle's Host plugin: environment detection, the `mworks_environment` tool, the prompt section, and the `/api/dsh-mworks-ai/environment` route the section reads. |

Both MCP rows use a five-minute tool timeout because a model check, translation or simulation can take minutes.

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
