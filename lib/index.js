/**
 * dsh-mworks-ai — Host half.
 *
 * Wires the MWORKS AI experience into DeepSeek Harness the way the official
 * Syslab AI / Sysplorer AI assistants do:
 *
 *   - this plugin contributes the two official MCP servers through the Host's
 *     MCP manager, so their connection state is observable and one of them can
 *     be rebuilt without restarting DeepSeek Harness;
 *   - it detects the local MWORKS installation and reports it to the agent (a
 *     read-only tool) and to the browser (a read-only route);
 *   - it adds the MWORKS working rules to the system prompt, including what to
 *     do when a Sysplorer call stops answering instead of retrying blindly.
 *
 * Why the MCP manager owns the servers: a stdio MCP child that is alive but
 * wedged (the Sysplorer engine it attached to was restarted underneath it)
 * never emits close/error, so the client bridge has nothing to reconnect on and
 * every call blocks until its per-call timeout. Remounting the child through
 * `mcpManager.restart()` re-runs discovery and re-attaches to the live engine
 * port, which is what actually recovers the session.
 *
 * The plugin only reads paths and version files: it writes nothing into the
 * MWORKS installation directories, and it never starts a GUI itself.
 *
 * @module dsh-mworks-ai
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

/** Cordis plugin name. */
export const name = 'mworks-ai'

/** Services this plugin contributes to; the plugin still loads without them. */
export const inject = ['tools', 'systemPrompt']

const ROUTE_PREFIX = '/api/dsh-mworks-ai'

/**
 * Where an installation may live, resolved from the environment at runtime.
 *
 * Nothing here is a literal machine path: a name is a product convention
 * (`Syslab 2026b`), and every root comes from the environment — the profile's
 * own config, a MWORKS environment variable, or the well-known Windows base
 * directories — so the same bundle works on another machine, another drive, or
 * another MWORKS release.
 */
const ENV_KEYS = {
  syslab: ['MWORKS_SYSLAB_HOME', 'SYSLAB_HOME'],
  sysplorer: ['MWORKS_SYSPLORER_HOME', 'SYSPLORER_HOME'],
  julia: ['MWORKS_JULIA_HOME', 'SYSLAB_JULIA_HOME', 'JULIA_ROOT'],
  workspace: ['MWORKS_WORKSPACE'],
  home: ['MWORKS_HOME'],
}

/** Product directory prefixes; the year/edition suffix is whatever is installed. */
const PRODUCT_NAMES = { syslab: 'Syslab', sysplorer: 'Sysplorer' }

/** Directory children, tolerating a missing or unreadable parent. */
function children(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

/** Every environment-named value, in precedence order. */
function envValues(names) {
  return names
    .map((key) => process.env[key])
    .filter((value) => typeof value === 'string' && value.length > 0)
}

/** Drive roots, taken from the platform rather than assumed. */
function driveRoots() {
  if (process.platform !== 'win32') return []
  const roots = []
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    if (existsSync(root)) roots.push(root)
  }
  return roots
}

/**
 * Directories to look inside for a product folder.
 *
 * A drive is scanned only through its `MWORKS` folder — the installer's default
 * layout — so discovery never walks a whole disk.
 */
function productBases() {
  const bases = new Set()
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) bases.add(value)
  }
  for (const key of ENV_KEYS.home) add(process.env[key])
  add(process.env.ProgramFiles)
  add(process.env['ProgramFiles(x86)'])
  add(process.env.LOCALAPPDATA)
  add(homedir())
  if (process.env.ProgramFiles !== undefined) add(join(process.env.ProgramFiles, 'MWORKS'))
  for (const drive of driveRoots()) add(join(drive, 'MWORKS'))
  return [...bases]
}

/**
 * Resolve one product directory.
 *
 * Precedence: the profile's own config, then the product's environment
 * variables, then a directory scan. A scan hit only counts when the product's
 * payload is there, so a leftover folder cannot be mistaken for an install.
 *
 * @param kind - `syslab` or `sysplorer`.
 * @param configured - an explicit path from the plugin's config, if any.
 * @returns every matching directory, best first.
 */
function resolveProduct(kind, configured) {
  const explicit = [
    ...(typeof configured === 'string' && configured.length > 0 ? [configured] : []),
    ...envValues(ENV_KEYS[kind]),
  ].filter((path) => existsSync(path))

  const prefix = PRODUCT_NAMES[kind]
  const scanned = []
  for (const base of productBases()) {
    for (const dir of children(base)) {
      if (!basename(dir).startsWith(`${prefix} `)) continue
      scanned.push(dir)
    }
  }

  // Newest release name first, so a 2026b install wins over 2025a.
  const ordered = [...new Set([...explicit, ...scanned.sort().reverse()])]
  return ordered
}

/** Whether a directory is a Julia runtime rather than a folder that merely resembles one. */
function isJuliaRuntime(dir) {
  if (!existsSync(dir)) return false
  const executable = process.platform === 'win32' ? 'julia.exe' : 'julia'
  return existsSync(join(dir, 'bin', executable))
}

/** Julia runtimes, from config, then the environment, then the usual trees. */
function resolveJulia(configured) {
  const explicit = [
    ...(typeof configured === 'string' && configured.length > 0 ? [configured] : []),
    ...envValues(ENV_KEYS.julia),
  ].filter(isJuliaRuntime)

  const bases = [
    process.env.PUBLIC,
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Programs'),
    homedir(),
  ].filter((base) => typeof base === 'string' && base.length > 0)

  const scanned = []
  for (const base of bases) {
    // `<base>/julia-*` and `<base>/<vendor>/julia-*`: MWORKS keeps its runtime
    // either beside the vendor folder or one level inside it.
    for (const parent of [base, ...children(base)]) {
      for (const dir of children(parent)) {
        const name = basename(dir)
        if (!name.startsWith('julia')) continue
        if (isJuliaRuntime(dir)) scanned.push(dir)
      }
    }
  }

  return [...new Set([...explicit, ...scanned.sort().reverse()])]
}

/** Preferred workspace for modeling output; the installation dirs stay read-only. */
function resolveWorkspace(configured) {
  for (const value of [configured, ...envValues(ENV_KEYS.workspace)]) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return join(homedir(), '.dsh-mworks-ai', 'workspace')
}

/**
 * What each MCP server is, independent of where it lives.
 *
 * Startup parameters were verified against the installed servers:
 *   - Syslab needs `--syslab-root` (the server panics without it) and must run
 *     `--syslab-display-mode=nodesktop`, or Julia calls attach to an already
 *     open Syslab desktop and leave stray processes behind.
 *   - Sysplorer must start through `Tools/sysplorer_mcp/main.py`, the launcher
 *     that exports MCP_DEPLOY_ROOT; starting the inner `main.py` breaks
 *     resources_retrieval while `tools/list` still looks healthy.
 */
const SERVER_META = {
  mworks_syslab: { label: 'Syslab MCP Server', declaredTools: 8 },
  mworks_sysplorer: { label: 'Sysplorer MCP Server', declaredTools: 15 },
}

const SERVER_NAMES = Object.keys(SERVER_META)

/** Timeouts shared by both servers; a check or simulation can take minutes. */
function serverTimeouts() {
  return {
    toolCallTimeoutMs: 300000,
    startupTimeoutMs: 60000,
    closeTimeoutMs: 15000,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 5000, maxAttempts: 10 },
  }
}

/**
 * Build the MCP server entries from what was actually found.
 *
 * A product that is not installed contributes no server at all: registering a
 * command that cannot start would only turn into a failing server in the list.
 *
 * @param installation - the resolved installation facts.
 * @param workspace - the resolved working directory.
 */
function resolveServers(installation, workspace) {
  const servers = []
  const { syslab, sysplorer, julia } = installation

  if (syslab.mcpServer !== undefined) {
    servers.push({
      serverName: 'mworks_syslab',
      ...SERVER_META.mworks_syslab,
      entry: {
        transport: 'stdio',
        command: syslab.mcpServer,
        args: [
          `--syslab-root=${syslab.root}`,
          ...(julia.root === undefined ? [] : [`--julia-root=${julia.root}`]),
          '--syslab-display-mode=nodesktop',
          '--initialize-syslab-on-startup=false',
          '--pkg-offline=true',
          `--initial-working-folder=${workspace}`,
        ],
        env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        cwd: workspace,
        ...serverTimeouts(),
      },
    })
  }

  if (sysplorer.mcpLauncher !== undefined && sysplorer.mcpPython !== undefined) {
    servers.push({
      serverName: 'mworks_sysplorer',
      ...SERVER_META.mworks_sysplorer,
      entry: {
        transport: 'stdio',
        command: sysplorer.mcpPython,
        args: [
          sysplorer.mcpLauncher,
          '--mworks-install-dir',
          sysplorer.root,
          '--sysplorer-platform-label',
          basename(sysplorer.root),
          '--workspace-dir',
          workspace,
        ],
        env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        cwd: workspace,
        ...serverTimeouts(),
      },
    })
  }

  return servers
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

/** Return the first existing directory, plus every one that does. */
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

/** Skill names MWORKS owns; everything else in a shared directory is left alone. */
const MWORKS_SKILL_PREFIXES = ['ty-', 'syslab-', 'ta-']

/** Whether a skill name belongs to MWORKS rather than another product. */
function isMworksSkillName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (name === 'modelica-library-workflow' || name === 'sysplorer-mds-docs') return true
  return MWORKS_SKILL_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * Read a `SKILL.md` frontmatter block.
 *
 * Handles the two shapes MWORKS actually ships: `key: value`, and a folded or
 * literal block (`>-`, `|`, …) whose body is the following indented lines. A
 * nested block such as `metadata:` is skipped, because a name and description
 * are all the registry needs.
 *
 * @param text - the whole file.
 * @returns the top-level scalar fields, or `undefined` without frontmatter.
 */
function parseSkillFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return undefined
  const lines = match[1].split(/\r?\n/)
  const fields = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue
    if (/^\s/.test(line)) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (value === '>-' || value === '>' || value === '|' || value === '|-') {
      const folded = value.startsWith('>')
      const collected = []
      let next = index + 1
      while (next < lines.length && (lines[next].trim().length === 0 || /^\s/.test(lines[next]))) {
        collected.push(lines[next].trim())
        next += 1
      }
      index = next - 1
      fields[key] = folded
        ? collected.join(' ').replace(/\s+/g, ' ').trim()
        : collected.join('\n').trim()
      continue
    }
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  return fields
}

/**
 * Directories that hold MWORKS skills, most authoritative first.
 *
 * The installation's own copies come first: they ship with the product and are
 * byte-identical to what the MWORKS installers copy into an AI client's skill
 * directory. The client directories are a fallback for an installation whose
 * `Tools/` payload was pruned but whose skills were already installed
 * elsewhere.
 */
function skillCandidateRoots(installation) {
  return [
    // Everything below the installation's own skill directories is MWORKS', so
    // no name filter applies: a new bundle must not need a code change here.
    { path: installation.sysplorer.modelingSkillsDir, authoritative: true },
    { path: installation.syslab.skillsDir, authoritative: true },
    // Shared client directories hold other products' skills too, so only names
    // MWORKS is known to own are taken from them.
    { path: join(homedir(), '.config', 'opencode', 'skills'), authoritative: false },
    { path: join(homedir(), '.claude', 'skills'), authoritative: false },
  ].filter((root) => typeof root.path === 'string' && root.path.length > 0 && existsSync(root.path))
}

/**
 * Discover the MWORKS skill bundles under an explicit list of roots.
 *
 * Pure with respect to the machine: the caller supplies the roots, so a test
 * can drive it from a fixture tree instead of needing MWORKS installed.
 *
 * @param roots - `{ path, authoritative }` entries, most authoritative first.
 * @returns the bundles, keyed by skill name, in root order.
 */
function discoverSkillBundlesIn(roots) {
  const bundles = new Map()

  for (const root of roots) {
    let entries = []
    try {
      entries = readdirSync(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (!root.authoritative && !isMworksSkillName(entry.name)) continue
      if (bundles.has(entry.name)) continue

      const dir = join(root.path, entry.name)
      const file = join(dir, 'SKILL.md')
      if (!existsSync(file)) continue
      let text
      try {
        text = readFileSync(file, { encoding: 'utf8', flag: 'r' })
      } catch {
        continue
      }
      const fields = parseSkillFrontmatter(text)
      if (fields === undefined) continue
      const declaredName = typeof fields.name === 'string' && fields.name.length > 0 ? fields.name : entry.name
      const description = typeof fields.description === 'string' ? fields.description.trim() : ''
      if (description.length === 0) continue
      // `name` must match the kebab-case grammar the registry enforces.
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(declaredName)) continue

      bundles.set(declaredName, {
        name: declaredName,
        description,
        whenToUse: typeof fields.whenToUse === 'string' ? fields.whenToUse.trim() : undefined,
        dir,
        content: text.slice(text.indexOf('---', 3) + 3).replace(/^\r?\n+/, ''),
      })
    }
  }

  return [...bundles.values()]
}

/**
 * Discover the MWORKS skill bundles this machine actually has.
 *
 * @param installation - the resolved installation facts.
 * @returns the bundles and the roots that were scanned.
 */
function discoverSkillBundles(installation) {
  const roots = skillCandidateRoots(installation)
  return { bundles: discoverSkillBundlesIn(roots), roots }
}


/**
 * Filesystem installation facts. Pure and synchronous: the route, the tools and
 * the prompt all read the same value.
 *
 * @param config - optional explicit paths (`syslabRoot`, `sysplorerRoot`,
 *   `juliaRoot`, `workspace`); detection falls back to the environment.
 */
function detectInstallation(config = {}) {
  const syslab = pickRoot(resolveProduct('syslab', config?.syslabRoot))
  const sysplorer = pickRoot(resolveProduct('sysplorer', config?.sysplorerRoot))
  const julia = pickRoot(resolveJulia(config?.juliaRoot))

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
  // The bundled interpreter is `python.exe` on Windows; the other names keep the
  // probe honest on a POSIX host (and in tests that run off Windows).
  const sysplorerPython = sysplorer.root === undefined
    ? undefined
    : ['python.exe', 'python3', 'python']
      .map((file) => join(sysplorer.root, 'External', 'python64', file))
      .find((path) => existsSync(path))

  const modelingSkills = sysplorer.root === undefined
    ? undefined
    : join(sysplorer.root, 'Tools', 'sysplorer_mcp', 'resources', 'modeling_skills')
  const syslabSkills = syslab.root === undefined
    ? undefined
    : join(syslab.root, 'Tools', 'syslab-skills')

  return {
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
      modelingSkillsDir: modelingSkills,
      modelingSkillsAvailable: modelingSkills === undefined ? false : existsSync(modelingSkills),
    },
    julia: {
      installed: julia.root !== undefined,
      root: julia.root,
      otherRoots: julia.existing.slice(1),
    },
  }
}

/** The skill registry, when the profile mounts one. */
function skillRegistryOf(ctx) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
    return registry !== undefined && registry !== null && typeof registry.register === 'function' ? registry : undefined
  } catch {
    return undefined
  }
}

/**
 * Which MWORKS skills the agent can actually load right now.
 *
 * The registry is the authority: it merges every provider, so its answer
 * already accounts for whatever else supplies skills in this profile (a local
 * directory provider, or another plugin that reads some client's skill folder).
 * The on-disk discovery is the fallback for a profile with no registry, and
 * always supplies the root list for diagnosis.
 *
 * @param ctx - a context that can resolve `skills`.
 * @param installation - the resolved installation facts.
 */
async function readSkillCatalog(ctx, installation) {
  const { bundles, roots } = discoverSkillBundles(installation)
  const onDisk = bundles.map((bundle) => bundle.name).sort()

  const registry = skillRegistryOf(ctx)
  if (registry === undefined || typeof registry.list !== 'function') {
    return { source: 'filesystem', registry: false, onDisk, roots: roots.map((root) => ({ path: root.path, authoritative: root.authoritative === true })), mworks: onDisk }
  }

  try {
    const all = await registry.list({})
    const names = all
      .map((skill) => skill.name)
      .filter((name) => isMworksSkillName(name))
      .sort()
    return { source: 'registry', registry: true, onDisk, roots: roots.map((root) => ({ path: root.path, authoritative: root.authoritative === true })), mworks: names }
  } catch {
    return { source: 'filesystem', registry: false, onDisk, roots: roots.map((root) => ({ path: root.path, authoritative: root.authoritative === true })), mworks: onDisk }
  }
}

/**
 * Supply the MWORKS skills without depending on any other component.
 *
 * MWORKS installers copy the skill bundles into an AI client's skill directory
 * (`%USERPROFILE%\\.config\\opencode\\skills` for OpenCode), and no DeepSeek
 * Harness provider scans that path on its own. This plugin registers them from
 * the copies that ship inside the MWORKS installation, the way a skill bundle
 * registers its own `skills/` directory.
 *
 * It registers them unconditionally rather than only where another provider
 * left a hole. Deferring would tie availability to a component this bundle does
 * not own: a provider that is absent, disabled, or serving a stale list would
 * take the skills with it, even though the installation is right there. The
 * registry resolves duplicate names by rank, so our copy is the one that wins,
 * and the contribution is re-evaluated on `skills/change` so an installed or
 * deleted bundle is picked up or released.
 *
 * Set `registerSkills: false` on the row to opt out of the contribution.
 *
 * @param ctx - the plugin context.
 * @param logger - diagnostics sink.
 * @param options - `registerSkills` false disables the contribution.
 */
function contributeSkills(ctx, logger, options = {}) {
  if (options.registerSkills === false) {
    logger?.info?.('dsh-mworks-ai: skill contribution disabled by config')
    return
  }
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => {
      // Name -> disposer for what this plugin currently owns.
      const owned = new Map()
      let cancelled = false
      let running = false
      let dirty = false
      let timer

      const release = () => {
        for (const dispose of owned.values()) {
          try {
            dispose()
          } catch {
            // A failed unregister during teardown must not mask the rest.
          }
        }
        owned.clear()
      }

      /**
       * Bring the registry in line with what is on disk right now.
       *
       * This plugin supplies the MWORKS skills itself and does not defer to any
       * other provider. Deferring would make availability depend on a component
       * this bundle does not own: if that provider is absent, disabled, or
       * serving a stale list, the skills would silently disappear even though
       * the installation is right there. Registering our own copies makes the
       * outcome the same in every profile — the registry resolves duplicates by
       * rank, so the installation's copy is the one that wins.
       *
       * Each pass releases names whose bundle is gone from disk (a deleted or
       * uninstalled bundle must not keep loading) and registers everything it
       * finds. Re-registering bumps the registry revision, so a pass that adds
       * nothing settles instead of looping.
       */
      const reconcile = async () => {
        if (cancelled) return
        if (running) {
          dirty = true
          return
        }
        running = true
        try {
          do {
            dirty = false
            const { bundles } = discoverSkillBundles(detectInstallation())
            const onDisk = new Set(bundles.map((bundle) => bundle.name))

            for (const [name, dispose] of [...owned]) {
              if (onDisk.has(name)) continue
              owned.delete(name)
              try {
                dispose()
              } catch {
                // Release is best effort; the entry is dropped either way.
              }
            }

            let added = 0
            for (const bundle of bundles) {
              if (owned.has(bundle.name)) continue
              try {
                owned.set(bundle.name, skillCtx.skills.register({
                  name: bundle.name,
                  description: bundle.description,
                  whenToUse: bundle.whenToUse,
                  content: bundle.content,
                  resourceBase: { kind: 'directory', path: bundle.dir },
                  source: 'custom',
                }))
                added += 1
              } catch (error) {
                logger?.warn?.(`dsh-mworks-ai: registering skill ${bundle.name} failed: ${String(error)}`)
              }
            }
            if (added > 0) {
              logger?.info?.(`dsh-mworks-ai: contributed ${added} MWORKS skills from the installation`)
            }
          } while (dirty && !cancelled)
        } finally {
          running = false
        }
      }

      // Coalesce bursts: one catalog revision can touch many providers.
      const schedule = () => {
        if (cancelled || timer !== undefined) return
        timer = setTimeout(() => {
          timer = undefined
          void reconcile()
        }, 300)
        timer.unref?.()
      }

      void reconcile()
      const off = typeof ctx.on === 'function' ? ctx.on('skills/change', schedule) : undefined

      return () => {
        cancelled = true
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        if (typeof off === 'function') {
          try {
            off()
          } catch {
            // The event service may already be gone during profile teardown.
          }
        }
        release()
      }
    }, 'dsh-mworks-ai: MWORKS skills')
  })
}

/** The MCP manager, when the profile mounts one. */
function mcpManagerOf(ctx) {
  try {
    const manager = typeof ctx.get === 'function' ? ctx.get('mcpManager') : undefined
    return manager !== undefined && manager !== null && typeof manager.list === 'function' ? manager : undefined
  } catch {
    return undefined
  }
}

/**
 * Live connection state of the two servers, read from the manager.
 *
 * This is the piece the bare `dsh-mcp-client` rows could not provide: a server
 * whose child is alive but wedged reports `connected` with a stale connection,
 * and only a restart clears it. Reporting the state is what turns a silent
 * five-minute stall into a visible, fixable condition.
 *
 * @param ctx - any context that can resolve `mcpManager`.
 * @returns `{ manager: boolean, servers: Report[] }`.
 */
function readMcpStatus(ctx) {
  const manager = mcpManagerOf(ctx)
  if (manager === undefined) {
    return {
      manager: false,
      servers: SERVER_NAMES.map((name) => ({
        server: name,
        label: SERVER_META[name].label,
        declaredTools: SERVER_META[name].declaredTools,
        state: 'unmanaged',
        healthy: false,
        detail: 'No MCP manager in this profile, so this plugin cannot report or restart the server.',
      })),
    }
  }

  let views = []
  try {
    views = manager.list()
  } catch {
    views = []
  }

  const servers = SERVER_NAMES.map((name) => {
    const view = views.find((entry) => entry.name === name)
    const status = view === undefined || view.status === undefined ? { state: 'absent' } : view.status
    return {
      server: name,
      label: SERVER_META[name].label,
      declaredTools: SERVER_META[name].declaredTools,
      state: status.state,
      healthy: status.state === 'connected',
      toolCount: typeof status.toolCount === 'number' ? status.toolCount : undefined,
      attempt: typeof status.attempt === 'number' ? status.attempt : undefined,
      maxAttempts: typeof status.maxAttempts === 'number' ? status.maxAttempts : undefined,
      reason: typeof status.reason === 'string' ? status.reason : undefined,
      lastError: typeof status.lastError === 'string' ? status.lastError : undefined,
      detail: describeState(status),
    }
  })

  return { manager: true, servers }
}

/** One line a human can act on for a connection state. */
function describeState(status) {
  switch (status.state) {
    case 'connected':
      return `connected${typeof status.toolCount === 'number' ? `, ${status.toolCount} tools registered` : ''}`
    case 'connecting':
      return `connecting${status.attempt > 0 ? ` (attempt ${status.attempt})` : ''}`
    case 'reconnecting':
      return `reconnecting (attempt ${status.attempt}/${status.maxAttempts})${status.lastError === undefined ? '' : `: ${status.lastError}`}`
    case 'failed':
      return `failed (${status.reason})${status.lastError === undefined ? '' : `: ${status.lastError}`} — tools are unregistered; restart the server`
    case 'waiting-credentials':
      return `waiting for credentials: ${status.lastError}`
    case 'closed':
      return 'closed'
    case 'disabled':
      return 'disabled'
    default:
      return String(status.state)
  }
}

/** Full report: installation facts, live MCP state, and the loadable skills. */
async function detectEnvironment(ctx) {
  const installation = detectInstallation()
  const mcp = readMcpStatus(ctx)
  const skills = await readSkillCatalog(ctx, installation)
  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    ...installation,
    mcp,
    skills,
    mcpServers: mcp.servers.map((server) => ({
      server: server.server,
      label: server.label,
      tools: server.declaredTools,
      state: server.state,
      healthy: server.healthy,
    })),
  }
}

/** Markdown report for the agent-facing tool. */
function renderEnvironment(environment) {
  const ready = (value) => (value === true ? 'ready' : 'not ready')
  const lines = [
    `MWORKS AI environment (${environment.platform}, ${environment.generatedAt})`,
    '',
    `Syslab: ${environment.syslab.installed ? environment.syslab.root : 'not found'}`,
  ]
  if (environment.syslab.build?.version !== undefined) {
    lines.push(`  version ${environment.syslab.build.version}${environment.syslab.build.buildDate === undefined ? '' : ` (built ${environment.syslab.build.buildDate})`}`)
  }
  if (environment.syslab.installed) {
    lines.push(`  MCP server: ${environment.syslab.mcpServer ?? 'missing'} — ${ready(environment.syslab.mcpServer !== undefined)}`)
    lines.push(`  Julia root: ${environment.julia.root ?? 'not found'} — ${ready(environment.julia.installed)}`)
  }

  lines.push('', `Sysplorer: ${environment.sysplorer.installed ? environment.sysplorer.root : 'not found'}`)
  if (environment.sysplorer.build?.version !== undefined) {
    lines.push(`  version ${environment.sysplorer.build.version}${environment.sysplorer.build.buildDate === undefined ? '' : ` (built ${environment.sysplorer.build.buildDate})`}`)
  }
  if (environment.sysplorer.installed) {
    lines.push(`  MCP launcher: ${environment.sysplorer.mcpLauncher ?? 'missing'} — ${ready(environment.sysplorer.mcpLauncher !== undefined)}`)
    lines.push(`  MCP Python: ${environment.sysplorer.mcpPython ?? 'missing'} — ${ready(environment.sysplorer.mcpPython !== undefined)}`)
    lines.push(`  modeling skills: ${environment.sysplorer.modelingSkillsAvailable ? environment.sysplorer.modelingSkillsDir : 'not found'}`)
  }

  lines.push('', 'MCP connection state:')
  for (const server of environment.mcp.servers) {
    lines.push(`  ${server.server}: ${server.state} — ${server.detail}`)
  }
  if (environment.mcp.manager !== true) {
    lines.push('  (no MCP manager in this profile: state cannot be reported or repaired)')
  }

  const skills = environment.skills
  lines.push('', `MWORKS skills loadable in this session: ${skills.mworks.length}`)
  if (skills.mworks.length > 0) lines.push(`  ${skills.mworks.join(', ')}`)
  if (skills.source === 'registry') {
    lines.push('  (resolved from the skill registry, which merges every provider in this profile)')
  } else {
    lines.push('  (no skill registry answered: this list is what the MWORKS installation ships)')
  }
  if (skills.onDisk.length !== skills.mworks.length) {
    lines.push(`  on disk: ${skills.onDisk.length} MWORKS skill bundles`)
  }
  if (skills.roots.length > 0) {
    lines.push(`  skill roots: ${skills.roots.map((entry) => entry.path).join(', ')}`)
  }

  return lines.join('\n')
}

/** Markdown report for `mworks_mcp_status`. */
function renderMcpStatus(status) {
  if (status.manager !== true) {
    return 'No MCP manager is mounted in this profile, so the MWORKS MCP servers cannot be reported or restarted from here. Reload the plugin or restart DeepSeek Harness to reconnect them.'
  }
  const lines = ['MWORKS MCP servers:']
  for (const server of status.servers) {
    const tools = server.toolCount === undefined
      ? `${server.declaredTools} declared`
      : `${server.toolCount} registered`
    lines.push(`  ${server.server} (${server.label}): ${server.state} — ${tools} tools`)
    // The state word already says the rest for a healthy server.
    if (server.state !== 'connected' && typeof server.detail === 'string' && server.detail.length > 0) {
      lines.push(`    ${server.detail}`)
    }
  }
  const broken = status.servers.filter((server) => !server.healthy)
  if (broken.length > 0) {
    lines.push(
      '',
      `Not connected: ${broken.map((server) => server.server).join(', ')}. Call mworks_mcp_restart with that server name to rebuild it, then verify with the server's own health tool. Do not retry a call that already timed out before restarting.`,
    )
  }
  return lines.join('\n')
}

/**
 * Working rules for the agent.
 *
 * The MWORKS domain knowledge lives in the MWORKS skills and each tool's own
 * description; this section carries only what the agent must not get wrong,
 * including how to react to an unresponsive Sysplorer.
 */
function guidanceText(installation) {
  const lines = [
    'MWORKS AI is available in this session: the Syslab MCP server exposes Julia/Syslab work and the Sysplorer MCP server exposes Modelica modeling and simulation.',
    'Follow the official MWORKS assistants\' order:',
    '1. For Syslab work, call `mcp__mworks_syslab__read_syslab_skill` with `skill_path` set to "default" and then `mcp__mworks_syslab__detect_syslab_toolboxes` before any code execution; the server rejects `evaluate_julia_code` and `run_julia_file` until both have run.',
    '2. Prefer installed `Ty*` packages over community packages, and confirm unfamiliar APIs from the local help (`search_syslab_docs` / `read_syslab_doc` for Syslab, `get_api_document` / `get_lib_model_document` for Sysplorer) instead of guessing.',
    '3. For Sysplorer work, call `mcp__mworks_sysplorer__session_manager` before other Sysplorer tools, and follow the selected MWORKS skill (for example `ty-sysplorer-modeling-rules`) when the task builds or repairs a model.',
    '4. Do not write modeling outputs into the MWORKS installation directories; use the session working directory.',
    '5. Validate what you changed: run the MWORKS checks the task requires (model check, translation, simulation, or the Julia script itself) and report what actually ran.',
    'When a MWORKS MCP call stops answering:',
    '- A call that times out may mean the server\'s child process is alive but detached from the Sysplorer engine (the engine was restarted, and the child is still pointing at the old port). Retrying cannot fix that and costs another full timeout.',
    '- Call `mworks_mcp_status` to read the live connection state. If a server is not `connected`, call `mworks_mcp_restart` with its name; that remounts the MCP child and re-attaches it to the running engine without restarting DeepSeek Harness or Sysplorer.',
    '- Never call `mcp__mworks_sysplorer__session_manager` with `restart`, `full_reset`, `force_restart` or `shutdown` to recover from this: those drive the Sysplorer engine itself, which every other MWORKS window shares. Use `mworks_mcp_restart` instead, and ask the user before touching the engine.',
    '- If a restart does not restore the connection, report the state and the last error to the user instead of retrying.',
  ]

  const missing = []
  if (!installation.syslab.installed) missing.push('Syslab')
  if (!installation.sysplorer.installed) missing.push('Sysplorer')
  if (missing.length > 0) {
    lines.push(
      `A local MWORKS installation for ${missing.join(' and ')} was not found by the MWORKS AI plugin, so its MCP server may fail to start; tell the user instead of retrying blindly.`,
    )
  }

  return lines.join('\n')
}

/** Serialize one JSON response with the no-store policy the UI needs. */
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
 * Drop `undefined` properties so a tool's canonical output stays lossless JSON.
 *
 * Optional facts (a version, a tool count, a last error) are naturally absent
 * rather than null; the tool validator rejects `undefined` inside a returned
 * value, so absence is expressed by omission.
 */
function compact(value) {
  if (Array.isArray(value)) return value.map(compact)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    out[key] = compact(entry)
  }
  return out
}

/**
 * Reject a cross-site browser request.
 *
 * The routes are same-origin fetches from the served page. A request that
 * declares another origin, or that the browser marks as cross-site, did not
 * come from the page this plugin renders into.
 */
function isSameOrigin(request) {
  const headers = request.headers ?? {}
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    return new URL(origin).host === headers.host
  } catch {
    return false
  }
}

/** The connection service, when the profile mounts one. */
function connectionOf(ctx) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    return connection !== undefined && connection !== null && typeof connection.requestRejection === 'function'
      ? connection
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Decide whether a request may reach the route.
 *
 * When the profile mounts the Host's `connection` service, that service alone
 * decides — the same call the Host's own routes make. It is the authority on
 * this question: it owns the Host fence (what defeats DNS rebinding), the
 * cross-site and Origin fences, the browser credential, and the deployment's
 * `trustedHosts` policy. Re-checking its verdict locally would be both
 * redundant and wrong: this plugin cannot see `trustedHosts`, so a second
 * opinion could reject traffic the deployment deliberately trusts (a Proxy that
 * rewrites `Host`, for example).
 *
 * Without that service there is nothing to delegate to, so the local
 * same-origin test runs instead as a weaker fallback. It is deliberately not
 * the only defence even there: a browser read over plain HTTP carries neither
 * Origin nor Fetch-Metadata, so `/restart` also requires a JSON media type.
 *
 * @returns true when the response is already finished and the route must stop.
 */
function refuseRequest(ctx, request, response) {
  const connection = connectionOf(ctx)
  if (connection !== undefined) {
    let rejection
    try {
      rejection = connection.requestRejection(request)
    } catch {
      // A guard that fails must refuse, never fall through.
      rejection = 403
    }
    if (rejection !== undefined && rejection !== null) {
      response.writeHead(rejection, { 'cache-control': 'no-store' })
      response.end()
      return true
    }
    return false
  }
  if (!isSameOrigin(request)) {
    sendJson(response, 403, { ok: false, error: 'cross-site request refused' })
    return true
  }
  return false
}

/** Read a bounded JSON body. */
async function readJsonBody(request, limit = 8192) {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
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

  // -------------------------------------------------------------------- skills
  // Register the MWORKS skill bundles from the installation's own copies, so a
  // session does not depend on another AI client's skill folder.
  contributeSkills(ctx, logger, { registerSkills: config?.registerSkills !== false })

  // ------------------------------------------------------------------ MCP servers
  // Contributed through the manager so their state is observable and one of
  // them can be rebuilt in place. Without a manager the tools below still load
  // and say so, instead of failing the whole plugin.
  //
  // The entries are resolved here, not at module scope: their command, args and
  // working directory all come from what this machine has installed.
  const installation = detectInstallation(config)
  const workspace = resolveWorkspace(config?.workspace)
  const servers = resolveServers(installation, workspace)
  if (servers.length < SERVER_NAMES.length) {
    const missing = SERVER_NAMES.filter((name) => !servers.some((server) => server.serverName === name))
    logger?.info?.(`dsh-mworks-ai: no MCP server for ${missing.join(', ')}; the product is not installed or not found`)
  }
  if (servers.length > 0) {
    try {
      mkdirSync(workspace, { recursive: true })
    } catch (error) {
      logger?.warn?.(`dsh-mworks-ai: could not create the workspace ${workspace}: ${String(error)}`)
    }
  }

  ctx.inject(['mcpManager'], (mcpCtx) => {
    const manager = mcpCtx.mcpManager
    for (const server of servers) {
      mcpCtx.effect(() => {
        try {
          const dispose = manager.register(server.serverName, { ...server.entry })
          logger?.info?.(`dsh-mworks-ai: registered MCP server ${server.serverName}`)
          return () => {
            try {
              dispose()
            } catch (error) {
              logger?.warn?.(`dsh-mworks-ai: removing ${server.serverName} failed: ${String(error)}`)
            }
          }
        } catch (error) {
          logger?.error?.(
            `dsh-mworks-ai: could not register ${server.serverName} (${String(error)}); its tools will be missing`,
          )
          return () => {}
        }
      }, `dsh-mworks-ai: MCP ${server.serverName}`)
    }
  })

  // -------------------------------------------------------------------- tools
  if (typeof ctx.tools?.register === 'function') {
    ctx.effect(() => ctx.tools.register({
      name: 'mworks_environment',
      description: 'Report the local MWORKS installation the MWORKS AI plugin found (Syslab and Sysplorer roots, versions, MCP entry points, the Julia runtime, the MWORKS skills this session can use) and the live connection state of both MWORKS MCP servers. Call it before MWORKS work when a path or version matters, and after a MWORKS MCP call fails.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderEnvironment(value) }],
      },
      async execute() {
        return compact(await detectEnvironment(ctx))
      },
    }), 'dsh-mworks-ai: mworks_environment tool')

    ctx.effect(() => ctx.tools.register({
      name: 'mworks_mcp_status',
      description: 'Read the live connection state of the two MWORKS MCP servers (connecting, connected, reconnecting, failed) with the registered tool count and the last error. Call this instead of retrying a MWORKS MCP call that timed out: retrying a detached server only burns another full timeout.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderMcpStatus(value) }],
      },
      async execute() {
        return compact(readMcpStatus(ctx))
      },
    }), 'dsh-mworks-ai: mworks_mcp_status tool')

    ctx.effect(() => ctx.tools.register({
      name: 'mworks_mcp_restart',
      description: 'Rebuild one MWORKS MCP server: replace its child process with a fresh one that re-discovers the running Sysplorer engine. Use this to recover a server that stopped answering, or that reports reconnecting/failed. It remounts only this MCP child; it does not restart Sysplorer, DeepSeek Harness, or any other MWORKS window.',
      parameters: {
        server: {
          type: 'string',
          required: true,
          enum: SERVER_NAMES,
          description: 'Which MWORKS MCP server to rebuild.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok === true
            ? `${value.server}: restart requested — ${value.detail ?? 'a fresh child is starting'}. Verify with the server's health tool before repeating the failed call.`
            : `${value.server}: restart failed — ${value.error ?? 'unknown error'}`,
        }],
      },
      async execute(args) {
        const manager = mcpManagerOf(ctx)
        if (manager === undefined) {
          return { ok: false, server: args.server, error: 'no MCP manager in this profile' }
        }
        try {
          await manager.restart(args.server)
        } catch (error) {
          return { ok: false, server: args.server, error: String(error?.message ?? error) }
        }
        // Give the fresh child a moment to reach its first state, then report.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const status = readMcpStatus(ctx)
        const server = status.servers.find((entry) => entry.server === args.server)
        return compact({
          ok: true,
          server: args.server,
          state: server?.state,
          healthy: server?.healthy === true,
          detail: server?.detail,
        })
      },
    }), 'dsh-mworks-ai: mworks_mcp_restart tool')
  }

  // ------------------------------------------------------------- system prompt
  if (typeof ctx.systemPrompt?.section === 'function') {
    const installation = detectInstallation()
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'mworks-ai',
      order: 300,
      text: guidanceText(installation),
    }), 'dsh-mworks-ai: prompt section')
  }

  // ------------------------------------------------------------------- routes
  ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/environment`,
      handler: async (request, response) => {
        if (refuseRequest(ctx, request, response)) return
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { allow: 'GET, HEAD' })
          response.end()
          return
        }
        try {
          sendJson(response, 200, await detectEnvironment(ctx))
        } catch (error) {
          logger?.warn?.(`dsh-mworks-ai: environment route failed: ${String(error)}`)
          sendJson(response, 500, { ok: false, error: String(error) })
        }
      },
    }), 'dsh-mworks-ai: environment route')

    serverCtx.effect(() => serverCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/restart`,
      handler: async (request, response) => {
        if (refuseRequest(ctx, request, response)) return
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        // A cross-site "simple request" can carry text/plain without a preflight,
        // so the media type is part of the gate rather than a nicety.
        const mediaType = String(request.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (mediaType !== 'application/json') {
          sendJson(response, 415, { ok: false, error: 'expected application/json' })
          return
        }
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          sendJson(response, 400, { ok: false, error: `bad request body: ${String(error?.message ?? error)}` })
          return
        }
        const serverName = body?.server
        if (typeof serverName !== 'string' || !SERVER_NAMES.includes(serverName)) {
          sendJson(response, 400, { ok: false, error: `unknown server; expected one of ${SERVER_NAMES.join(', ')}` })
          return
        }
        const manager = mcpManagerOf(ctx)
        if (manager === undefined) {
          sendJson(response, 503, { ok: false, error: 'no MCP manager in this profile' })
          return
        }
        try {
          await manager.restart(serverName)
        } catch (error) {
          sendJson(response, 500, { ok: false, server: serverName, error: String(error?.message ?? error) })
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
        sendJson(response, 200, { ok: true, server: serverName, mcp: readMcpStatus(ctx) })
      },
    }), 'dsh-mworks-ai: restart route')
  })

  logger?.info?.('dsh-mworks-ai: MWORKS AI host half active')
}

export {
  detectInstallation,
  detectEnvironment,
  readMcpStatus,
  discoverSkillBundles,
  discoverSkillBundlesIn,
  isMworksSkillName,
  resolveServers,
  resolveWorkspace,
  SERVER_META,
  SERVER_NAMES,
}
