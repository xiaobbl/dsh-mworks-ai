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
| Tools | `mcp__mworks_syslab__*` (8 tools: Julia execution, environment detection, help search, MATLAB→Julia mapping) and `mcp__mworks_sysplorer__*` (15 tools: session, library, model, check, translate, simulate, layout, results, plotting, API/model docs, resources). Plus `mworks_environment`, which reports the detected installation. |
| Instructions | The official MWORKS working rules: Syslab needs `read_syslab_skill` → `detect_syslab_toolboxes` before any code execution; prefer `Ty*` packages; confirm APIs from local help; call `session_manager` before other Sysplorer tools; keep outputs out of the installation directories. |
| UI | A **Runtime environment** section on this bundle's own page under **Plugins**, below the configuration the Plugin Manager draws. It lists the detected Syslab and Sysplorer installations and versions, the Julia runtime, both MCP servers with their path status, and the MWORKS skills this session can call, with a **Re-detect** button. The section renders nothing on any other plugin's page. Nothing is added to the conversation: no composer control, no chat row. |

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

`test/` holds three checks that run without the app:

```bash
node test/render-check.mjs     # renders the detail-page section
node test/class-check.mjs      # every class used is defined, every rule is used
node test/metadata-check.mjs   # display metadata and artwork limits
```

`render-check.mjs` is the one that matters for UI changes: it walks the real element tree and asserts the contract (only `plugins.detail.section`, null on foreign pages, no fetch before the page opens), so a component that throws — which makes the host blank the section — fails the check instead of shipping.

## Limits

- All MWORKS capability comes from the installed products. Without Syslab the Julia tools fail; without Sysplorer the Modelica tools fail. The section says which paths are missing instead of guessing.
- The plugin only reads paths and version files. It writes nothing into the MWORKS directories, and it never starts a GUI.
- The section reports installation state, not connection health: the tool counts are what the official servers declare (8 and 15), and calling a tool is the only proof that one answered. Run `mworks_environment`, or open this bundle's page under Plugins, to see what was detected.
- Turning the bundle off removes both MCP connections, the tool, the instructions and the button.
