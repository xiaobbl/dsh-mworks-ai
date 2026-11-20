/**
 * dsh-mworks-ai — Host half.
 *
 * Wires the MWORKS AI experience into DeepSeek Harness the way the official
 * Syslab AI / Sysplorer AI assistants do it:
 *
 *   - the two official MCP servers (wired as separate rows in
 *     cordis.patch.yml) supply the tool surface;
 *   - this Host plugin detects the local MWORKS installation, reports what it
 *     found to the agent (one read-only tool) and to the browser panel (one
 *     read-only route), and adds the MWORKS working rules to the system
 *     prompt so the agent follows the same order the official assistants do.
 *
 * Everything here is read-only with respect to the MWORKS installation: the
 * plugin only stats paths and reads version files.
 *
 * @module dsh-mworks-ai
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Cordis plugin name. */
export const name = 'mworks-ai'

/** Services this plugin contributes to; the plugin still loads without them. */
export const inject = ['tools', 'systemPrompt']

const ROUTE_PREFIX = '/api/dsh-mworks-ai'

/**
 * Directories the panel and the tool report. The first existing member of each
 * group wins, so a 2025a install keeps working beside 2026b.
 */
const SYSLAB_ROOTS = [
  'E:\\MWORKS\\Syslab 2026b',
  'E:\\MWORKS\\Syslab 2026a',
  'E:\\MWORKS\\Syslab 2025a',
  'C:\\Program Files\\MWORKS\\Syslab 2026b',
  'C:\\Program Files\\MWORKS\\Syslab 2026a',
  'C:\\Program Files\\MWORKS\\Syslab 2025a',
]

const SYSPLORER_ROOTS = [
  'E:\\MWORKS\\Sysplorer 2026b',
  'E:\\MWORKS\\Sysplorer 2026a',
  'E:\\MWORKS\\Sysplorer 2025a',
  'C:\\Program Files\\MWORKS\\Sysplorer 2026b',
  'C:\\Program Files\\MWORKS\\Sysplorer 2026a',
  'C:\\Program Files\\MWORKS\\Sysplorer 2025a',
]

const JULIA_ROOTS = [
  'C:\\Users\\Public\\TongYuan\\julia-1.10.10',
  join(homedir(), 'AppData', 'Local', 'Programs', 'julia'),
]

/** Folders an AI client installs MWORKS skills into, newest convention first. */
function skillRoots() {
  return [
    join(homedir(), '.config', 'opencode', 'skills'),
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.dsh', 'skills'),
  ]
}

/** Read the first existing file from a list of candidates, bounded and tolerant. */
function readFirstText(paths) {
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      return readFileSync(path, { encoding: 'utf8', flag: 'r' }).slice(0, 64 * 1024)
    } catch {
      // An unreadable candidate is not an installation fact worth failing on.
    }
  }
  return undefined
}

/** Return the first directory that exists, plus every one that does. */
function pickRoot(candidates) {
  const existing = candidates.filter((path) => existsSync(path))
  return { root: existing[0], existing }
}

/** Parse `versionInfo/build_info.json` when present. */
function readBuildInfo(root) {
  const raw = readFirstText([join(root, 'versionInfo', 'build_info.json')])
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return {
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
      buildDate: typeof parsed.build_date === 'string' ? parsed.build_date : undefined,
      channel: typeof parsed.mode === 'string' ? parsed.mode : undefined,
    }
  } catch {
    return undefined
  }
}

/** Count skill directories under one root, tolerating a missing or unreadable root. */
function scanSkills(root) {
  if (!existsSync(root)) return undefined
  try {
    const entries = readdirSync(root, { withFileTypes: true })
    const names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
    return { path: root, count: names.length, names }
  } catch {
    return undefined
  }
}

/**
 * Build the whole environment snapshot the panel and the tool report.
 *
 * @returns a plain JSON value: no Dates, no paths outside the reported fields.
 */
function detectEnvironment() {
  const syslab = pickRoot(SYSLAB_ROOTS)
  const sysplorer = pickRoot(SYSPLORER_ROOTS)
  const julia = pickRoot(JULIA_ROOTS)

  const syslabServer = syslab.root === undefined
    ? undefined
    : ['syslab-mcp-server-win64.exe', 'syslab-mcp-server-glnxa64', 'syslab-mcp-server-glnxarm64', 'syslab-mcp-server-winarm64']
      .map((file) => join(syslab.root, 'Tools', 'syslab-mcp-server', file))
      .find((path) => existsSync(path))

  // Sysplorer starts through the launcher, never the inner main.py: the
  // launcher is what exports MCP_DEPLOY_ROOT for the resources corpus.
  const sysplorerLauncher = sysplorer.root === undefined
    ? undefined
    : join(sysplorer.root, 'Tools', 'sysplorer_mcp', 'main.py')
  const sysplorerPython = sysplorer.root === undefined
    ? undefined
    : join(sysplorer.root, 'External', 'python64', 'python.exe')

  const modelicaSkills = sysplorer.root === undefined
    ? undefined
    : join(sysplorer.root, 'Tools', 'sysplorer_mcp', 'resources', 'modeling_skills')
  const syslabSkills = syslab.root === undefined
    ? undefined
    : join(syslab.root, 'Tools', 'syslab-skills')

  const roots = skillRoots()
  const detectedSkillRoots = roots
    .map(scanSkills)
    .filter((entry) => entry !== undefined)

  const mworksSkills = new Set()
  for (const entry of detectedSkillRoots) {
    for (const skillName of entry.names) {
      if (skillName.startsWith('ty-') || skillName.startsWith('syslab-') || skillName === 'modelica-library-workflow') {
        mworksSkills.add(skillName)
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    syslab: {
      installed: syslab.root !== undefined,
      root: syslab.root,
      otherRoots: syslab.existing.slice(1),
      build: syslab.root === undefined ? undefined : readBuildInfo(syslab.root),
      mcpServer: syslabServer,
      skillsDir: syslabSkills,
      skillsAvailable: syslabSkills === undefined ? false : existsSync(syslabSkills),
    },
    sysplorer: {
      installed: sysplorer.root !== undefined,
      root: sysplorer.root,
      otherRoots: sysplorer.existing.slice(1),
      build: sysplorer.root === undefined ? undefined : readBuildInfo(sysplorer.root),
      mcpLauncher: sysplorerLauncher,
      mcpPython: sysplorerPython,
      modelingSkillsDir: modelicaSkills,
      modelingSkillsAvailable: modelicaSkills === undefined ? false : existsSync(modelicaSkills),
    },
    julia: {
      installed: julia.root !== undefined,
      root: julia.root,
      otherRoots: julia.existing.slice(1),
    },
    skills: {
      roots: detectedSkillRoots.map((entry) => ({ path: entry.path, count: entry.count })),
      mworks: [...mworksSkills].sort(),
    },
    mcpServers: [
      {
        server: 'mworks_syslab',
        label: 'Syslab MCP Server',
        tools: 8,
        ready: syslabServer !== undefined && julia.root !== undefined,
      },
      {
        server: 'mworks_sysplorer',
        label: 'Sysplorer MCP Server',
        tools: 15,
        ready: sysplorerLauncher !== undefined && sysplorerPython !== undefined,
      },
    ],
  }
}

/**
 * Working rules the official Syslab AI and Sysplorer AI assistants carry.
 *
 * Kept short on purpose: the domain knowledge lives in the MWORKS skills, and
 * the tool descriptions already document each tool's own contract.
 */
function guidanceText(environment) {
  const lines = [
    'MWORKS AI is available in this session: the Syslab MCP server exposes Julia/Syslab work and the Sysplorer MCP server exposes Modelica modeling and simulation.',
    'Follow the official MWORKS assistants\' order:',
    '1. For Syslab work, call `mcp__mworks_syslab__read_syslab_skill` with `skill_path` set to "default" and then `mcp__mworks_syslab__detect_syslab_toolboxes` before any code execution; the server rejects `evaluate_julia_code` and `run_julia_file` until both have run.',
    '2. Prefer installed `Ty*` packages over community packages, and confirm unfamiliar APIs from the local help (`search_syslab_docs` / `read_syslab_doc` for Syslab, `get_api_document` / `get_lib_model_document` for Sysplorer) instead of guessing.',
    '3. For Sysplorer work, call `mcp__mworks_sysplorer__session_manager` before other Sysplorer tools, and follow the selected MWORKS skill (for example `ty-sysplorer-modeling-rules`) when the task builds or repairs a model.',
    '4. Do not write modeling outputs into the MWORKS installation directories; use the session working directory.',
    '5. Validate what you changed: run the MWORKS checks the task requires (model check, translation, simulation, or the Julia script itself) and report what actually ran.',
  ]

  const missing = []
  if (!environment.syslab.installed) missing.push('Syslab')
  if (!environment.sysplorer.installed) missing.push('Sysplorer')
  if (missing.length > 0) {
    lines.push(
      `A local MWORKS installation for ${missing.join(' and ')} was not found by the MWORKS AI plugin, so its MCP server may fail to start; tell the user instead of retrying blindly.`,
    )
  }

  return lines.join('\n')
}

/** Serialize one JSON response with the no-store policy the panel needs. */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Markdown summary of one environment snapshot, for the agent-facing tool.
 *
 * The panel renders its own view from the same value, so this text only has to
 * read well in a transcript.
 */
function renderEnvironment(environment) {
  const ok = (value) => (value === true ? 'ready' : 'not ready')
  const lines = [
    `MWORKS AI environment (${environment.platform}, ${environment.generatedAt})`,
    '',
    `Syslab: ${environment.syslab.installed ? environment.syslab.root : 'not found'}`,
  ]
  if (environment.syslab.build?.version !== undefined) {
    lines.push(`  version ${environment.syslab.build.version}${environment.syslab.build.buildDate === undefined ? '' : ` (built ${environment.syslab.build.buildDate})`}`)
  }
  if (environment.syslab.installed) {
    lines.push(`  MCP server: ${environment.syslab.mcpServer ?? 'missing'} — ${ok(environment.syslab.mcpServer !== undefined)}`)
    lines.push(`  Julia root: ${environment.julia.root ?? 'not found'} — ${ok(environment.julia.installed)}`)
  }

  lines.push('', `Sysplorer: ${environment.sysplorer.installed ? environment.sysplorer.root : 'not found'}`)
  if (environment.sysplorer.build?.version !== undefined) {
    lines.push(`  version ${environment.sysplorer.build.version}${environment.sysplorer.build.buildDate === undefined ? '' : ` (built ${environment.sysplorer.build.buildDate})`}`)
  }
  if (environment.sysplorer.installed) {
    lines.push(`  MCP launcher: ${environment.sysplorer.mcpLauncher ?? 'missing'} — ${ok(environment.sysplorer.mcpLauncher !== undefined)}`)
    lines.push(`  MCP Python: ${environment.sysplorer.mcpPython ?? 'missing'} — ${ok(environment.sysplorer.mcpPython !== undefined)}`)
    lines.push(`  modeling skills: ${environment.sysplorer.modelingSkillsAvailable ? environment.sysplorer.modelingSkillsDir : 'not found'}`)
  }

  lines.push('', 'MCP servers:')
  for (const server of environment.mcpServers) {
    lines.push(`  ${server.server} (${server.label}): ${server.ready ? 'configured' : 'incomplete'}, ${server.tools} tools when connected`)
  }

  lines.push('', `MWORKS skills visible to this session: ${environment.skills.mworks.length}`)
  if (environment.skills.mworks.length > 0) {
    lines.push(`  ${environment.skills.mworks.join(', ')}`)
  }
  if (environment.skills.roots.length > 0) {
    lines.push(`  skill roots: ${environment.skills.roots.map((entry) => `${entry.path} (${entry.count})`).join(', ')}`)
  }

  return lines.join('\n')
}

/**
 * Plugin entry.
 *
 * @param ctx - Cordis context of this row.
 * @param config - the row's config; this plugin reads nothing from it today.
 */
export function apply(ctx, config) {
  void config
  const logger = ctx.logger

  // One snapshot per activation: the panel refreshes by reloading it, and the
  // tool re-detects on each call so a newly installed product shows up without
  // restarting the harness.
  if (typeof ctx.tools?.register === 'function') {
    ctx.effect(() => ctx.tools.register({
      name: 'mworks_environment',
      description: 'Report the local MWORKS installation the MWORKS AI plugin found: Syslab and Sysplorer roots, their versions, the MCP server entry points, the Julia runtime, and the MWORKS skills visible to this session. Call it before MWORKS work when a path or version matters, or when an MCP tool reports that it cannot find its installation.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderEnvironment(value) }],
      },
      async execute() {
        return detectEnvironment()
      },
    }), 'dsh-mworks-ai: mworks_environment tool')
  }

  if (typeof ctx.systemPrompt?.section === 'function') {
    const environment = detectEnvironment()
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'mworks-ai',
      order: 300,
      text: guidanceText(environment),
    }), 'dsh-mworks-ai: prompt section')
  }

  // The panel route. webServer is optional: a headless profile still gets the
  // tool and the prompt section.
  ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/environment`,
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { allow: 'GET, HEAD' })
          response.end()
          return
        }
        try {
          sendJson(response, 200, detectEnvironment())
        } catch (error) {
          logger?.warn?.(`dsh-mworks-ai: environment route failed: ${String(error)}`)
          sendJson(response, 500, { ok: false, error: String(error) })
        }
      },
    }), 'dsh-mworks-ai: environment route')
  })

  logger?.info?.('dsh-mworks-ai: MWORKS AI host half active')
}

export { detectEnvironment }
