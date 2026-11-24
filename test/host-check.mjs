/**
 * Host-half check: the MCP registration, the three tools, the prompt section,
 * the skill contribution, and both routes.
 *
 * The MCP servers are contributed through `mcpManager.register()`, so this test
 * pins that contract: names, entry fields, cleanup, and the status mapping that
 * turns manager state into what the agent and the page report.
 *
 * Nothing here may depend on MWORKS being installed: CI runs this on a Linux
 * runner with no MWORKS. Skill discovery and frontmatter parsing are driven
 * from a temporary fixture tree; the assertions that need the real installation
 * run only when this machine has one, and say so when they do not.
 *
 * Not shipped with the bundle.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const plugin = await import(`file:///${ROOT.replace(/\\/g, '/')}lib/index.js`)

// ---------------------------------------------------------------- fixture tree
// A throwaway installation: the plugin must resolve its paths from here, which
// is also how this test proves nothing is hardcoded to one machine.

const FIXTURE = mkdtempSync(join(tmpdir(), 'dsh-mworks-ai-'))
const FIXTURE_PATHS = {
  syslab: join(FIXTURE, 'syslab'),
  sysplorer: join(FIXTURE, 'sysplorer'),
  julia: join(FIXTURE, 'julia'),
  workspace: join(FIXTURE, 'workspace'),
}
const JULIA_EXE = process.platform === 'win32' ? 'julia.exe' : 'julia'
const FIXTURE_SKILLS = {
  modeling: 'ty-fixture-modeling',
  syslab: 'syslab-fixture-testing',
  foreign: 'unrelated-other-product',
}

function writeFile(path, text = '') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function writeSkill(root, name, description) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    'description: >-',
    `  ${description}`,
    '  continued on a second folded line',
    'metadata:',
    '  managed-by: test',
    '---',
    '',
    `# ${name}`,
    '',
    'Body text.',
    '',
  ].join('\n'))
}

writeSkill(join(FIXTURE_PATHS.sysplorer, 'Tools', 'sysplorer_mcp', 'resources', 'modeling_skills'), FIXTURE_SKILLS.modeling, 'Fixture modeling rules for the host check.')
writeSkill(join(FIXTURE_PATHS.syslab, 'Tools', 'syslab-skills'), FIXTURE_SKILLS.syslab, 'Fixture Syslab testing skill for the host check.')
writeFile(join(FIXTURE_PATHS.syslab, 'Tools', 'syslab-mcp-server', 'syslab-mcp-server-win64.exe'))
writeFile(join(FIXTURE_PATHS.sysplorer, 'Tools', 'sysplorer_mcp', 'main.py'), '# launcher fixture\n')
writeFile(join(FIXTURE_PATHS.sysplorer, 'External', 'python64', process.platform === 'win32' ? 'python.exe' : 'python'), '')
writeFile(join(FIXTURE_PATHS.julia, 'bin', JULIA_EXE), '')

// Point detection at the fixture, the way an operator would.
process.env.MWORKS_SYSLAB_HOME = FIXTURE_PATHS.syslab
process.env.MWORKS_SYSPLORER_HOME = FIXTURE_PATHS.sysplorer
process.env.MWORKS_JULIA_HOME = FIXTURE_PATHS.julia
process.env.MWORKS_WORKSPACE = FIXTURE_PATHS.workspace

// ------------------------------------------------------------------ fake context

const tools = new Map()
const sections = []
const routes = new Map()
const registrations = []
const cleanups = []
const logs = { info: [], warn: [], error: [] }

function makeManager(views) {
  return {
    list: () => views,
    restart: async (name) => { restarted.push(name) },
    register(name, entry) {
      registrations.push({ name, entry })
      return () => {
        const index = registrations.findIndex((r) => r.name === name)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  }
}
const restarted = []

const manager = makeManager([
  { name: 'mworks_syslab', status: { state: 'connected', toolCount: 8, connectedAt: Date.now() } },
  { name: 'mworks_sysplorer', status: { state: 'reconnecting', attempt: 3, maxAttempts: 10, nextRetryAtMs: Date.now() + 900, lastError: 'connection lost' } },
])

// A skill registry that already serves MWORKS skills would be respected; this
// fake starts empty so the plugin is expected to contribute its own.
const skillRegistrations = []
let registrySkills = []
// 'skills/change' listeners, so the tests can move the catalog the way another
// provider appearing or disappearing would.
const listeners = new Map()
const fireSkillsChange = async () => {
  for (const callback of listeners.get('skills/change') ?? []) callback()
  // The plugin debounces the reaction before it re-reads the catalog.
  await new Promise((resolve) => setTimeout(resolve, 400))
}
const skillsService = {
  async list() { return registrySkills },
  register(skill) {
    skillRegistrations.push(skill)
    return () => {
      const index = skillRegistrations.findIndex((entry) => entry.name === skill.name)
      if (index >= 0) skillRegistrations.splice(index, 1)
    }
  },
}

// The Host's connection service: the authoritative access check for a route.
// `rejection` is mutable so the tests can drive 401, 403 and "allowed". It also
// mimics the Host's own cross-site fence, because a real `connection` would
// refuse that before any plugin route sees the request.
let rejection = undefined
const connectionSeen = []
const connectionService = {
  requestRejection(request) {
    connectionSeen.push(request)
    if (rejection !== undefined) return rejection
    return request.headers?.['sec-fetch-site'] === 'cross-site' ? 403 : undefined
  },
}

const ctx = {
  logger: {
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
  },
  get: (name) => {
    if (name === 'mcpManager') return manager
    if (name === 'skills') return skillsService
    if (name === 'connection') return connectionService
    return undefined
  },
  effect(fn) {
    const cleanup = fn()
    cleanups.push(cleanup)
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  // Event subscription: the plugin re-checks the catalog on 'skills/change',
  // which is how a provider that disappears is noticed.
  on(name, callback) {
    const set = listeners.get(name) ?? new Set()
    set.add(callback)
    listeners.set(name, set)
    return () => set.delete(callback)
  },
  inject(names, callback) {
    // Both services exist in this fake profile.
    const scoped = {
      ...ctx,
      mcpManager: manager,
      skills: skillsService,
      webServer: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    }
    callback(scoped)
    return () => {}
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  systemPrompt: {
    section(section) { sections.push(section); return () => {} },
  },
}

plugin.apply(ctx, {})

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

// ---- exports
check(typeof plugin.apply === 'function', 'no apply export')
check(JSON.stringify(plugin.inject) === JSON.stringify(['tools', 'systemPrompt']), `inject is ${JSON.stringify(plugin.inject)}`)

// ---- MCP servers contributed through the manager
check(registrations.length === 2, `expected 2 MCP registrations, got ${registrations.length}`)
const byName = new Map(registrations.map((r) => [r.name, r.entry]))
for (const name of ['mworks_syslab', 'mworks_sysplorer']) {
  const entry = byName.get(name)
  check(entry !== undefined, `${name} was not registered with the MCP manager`)
  if (entry === undefined) continue
  check(entry.transport === 'stdio', `${name} transport is ${entry.transport}`)
  check(typeof entry.command === 'string' && entry.command.length > 0, `${name} has no command`)
  check(Array.isArray(entry.args), `${name} has no args array`)
  check(entry.toolCallTimeoutMs > 0, `${name} has no toolCallTimeoutMs`)
  check(entry.startupTimeoutMs > 0, `${name} has no startupTimeoutMs`)
  check(entry.reconnect?.enabled === true, `${name} does not enable reconnect`)
  check(entry.enabled !== false, `${name} entry is disabled`)
}
// The two facts that cost a debugging session to learn:
check(
  String(byName.get('mworks_sysplorer')?.args?.[0] ?? '').endsWith('main.py'),
  'Sysplorer must start through the launcher main.py, not the inner one',
)
check(
  (byName.get('mworks_syslab')?.args ?? []).includes('--syslab-display-mode=nodesktop'),
  'Syslab must run nodesktop',
)

// Every path must come from the resolved installation, never from a literal.
check(
  byName.get('mworks_syslab')?.command === join(FIXTURE_PATHS.syslab, 'Tools', 'syslab-mcp-server', 'syslab-mcp-server-win64.exe'),
  `Syslab command is not the resolved one: ${byName.get('mworks_syslab')?.command}`,
)
check(
  byName.get('mworks_sysplorer')?.command === join(FIXTURE_PATHS.sysplorer, 'External', 'python64', process.platform === 'win32' ? 'python.exe' : 'python'),
  `Sysplorer command is not the resolved one: ${byName.get('mworks_sysplorer')?.command}`,
)
check(
  (byName.get('mworks_syslab')?.args ?? []).includes(`--syslab-root=${FIXTURE_PATHS.syslab}`),
  'Syslab args do not carry the resolved root',
)
check(
  (byName.get('mworks_syslab')?.args ?? []).includes(`--julia-root=${FIXTURE_PATHS.julia}`),
  'Syslab args do not carry the resolved Julia runtime',
)
check(
  byName.get('mworks_sysplorer')?.cwd === FIXTURE_PATHS.workspace,
  `Sysplorer cwd is not the resolved workspace: ${byName.get('mworks_sysplorer')?.cwd}`,
)

// ---- the plugin source carries no machine path
{
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const driveLiterals = source.match(/['"`][A-Za-z]:[\\/]/g) ?? []
  check(driveLiterals.length === 0, `lib/index.js hardcodes a drive path: ${driveLiterals.join(', ')}`)
  const programFiles = source.match(/['"]C:[\\/]Program Files/g) ?? []
  check(programFiles.length === 0, 'lib/index.js hardcodes an install base directory')
}

// ---- a machine without MWORKS contributes no server, and does not throw
{
  const empty = { syslab: {}, sysplorer: {}, julia: {} }
  check(plugin.resolveServers(empty, FIXTURE_PATHS.workspace).length === 0, 'a missing installation produced MCP servers')
  check(plugin.resolveServers({ syslab: {}, sysplorer: { mcpLauncher: '/x/main.py', mcpPython: '/x/python', root: '/x' }, julia: {} }, FIXTURE_PATHS.workspace).length === 1, 'a partially installed machine did not contribute the product it has')
  // An explicit config path beats the environment, which is how a user corrects a wrong guess.
  const configured = plugin.detectInstallation({ syslabRoot: FIXTURE_PATHS.syslab, sysplorerRoot: FIXTURE_PATHS.sysplorer, juliaRoot: FIXTURE_PATHS.julia })
  check(configured.syslab.root === FIXTURE_PATHS.syslab, 'an explicit syslabRoot did not win')
  check(configured.julia.root === FIXTURE_PATHS.julia, 'an explicit juliaRoot did not win')
}

// ---- tools
for (const name of ['mworks_environment', 'mworks_mcp_status', 'mworks_mcp_restart']) {
  check(tools.has(name), `tool ${name} was not registered`)
}
const restartTool = tools.get('mworks_mcp_restart')
check(
  JSON.stringify(restartTool?.parameters?.server?.enum) === JSON.stringify(['mworks_syslab', 'mworks_sysplorer']),
  'restart tool does not constrain the server name',
)

// ---- prompt section
check(sections.length === 1, `expected 1 prompt section, got ${sections.length}`)
const guidance = typeof sections[0]?.text === 'string' ? sections[0].text : ''
for (const expected of ['mworks_mcp_status', 'mworks_mcp_restart', 'read_syslab_skill', 'detect_syslab_toolboxes']) {
  check(guidance.includes(expected), `guidance does not mention ${expected}`)
}
check(
  /never call .*session_manager.*restart/i.test(guidance),
  'guidance does not warn against using the engine-level restart to recover',
)

// ---- status mapping
const status = plugin.readMcpStatus(ctx)
check(status.manager === true, 'status did not see the manager')
const syslab = status.servers.find((s) => s.server === 'mworks_syslab')
const sysplorer = status.servers.find((s) => s.server === 'mworks_sysplorer')
check(syslab?.healthy === true && syslab?.state === 'connected', 'connected server is not reported healthy')
check(syslab?.detail?.includes('8 tools'), `connected detail is ${syslab?.detail}`)
check(sysplorer?.healthy === false, 'reconnecting server is reported healthy')
check(sysplorer?.detail?.includes('3/10'), `reconnecting detail is ${sysplorer?.detail}`)
check(sysplorer?.detail?.includes('connection lost'), 'reconnecting detail drops the last error')

// no manager at all
const without = plugin.readMcpStatus({ get: () => undefined })
check(without.manager === false, 'absence of a manager is not reported')
check(without.servers.every((s) => s.state === 'unmanaged' && s.healthy === false), 'unmanaged servers are not marked')

// ---- environment report
const environment = await plugin.detectEnvironment(ctx)
check(typeof environment.generatedAt === 'string', 'environment has no timestamp')
check(environment.mcp?.manager === true, 'environment report has no live MCP block')
check(Array.isArray(environment.mcpServers) && environment.mcpServers.length === 2, 'environment report has no server summary')
check(Array.isArray(environment.skills?.mworks), 'environment report has no skill list')
check(environment.skills?.source === 'registry', `skill source is ${environment.skills?.source}, expected registry`)
// The report is rendered from these entries: a nested object prints as
// "[object Object]" and hides the path the user needs for diagnosis.
check(
  environment.skills.roots.every((root) => typeof root.path === 'string' && root.path.length > 0),
  'a detected skill root has no path string',
)

// ---- skills contributed from the installation, not from another client's folder
await new Promise((resolve) => setTimeout(resolve, 0))
const registeredNames = skillRegistrations.map((skill) => skill.name)
for (const expected of [FIXTURE_SKILLS.modeling, FIXTURE_SKILLS.syslab]) {
  check(registeredNames.includes(expected), `${expected} was not registered from the fixture installation`)
}
check(
  skillRegistrations.every((skill) => typeof skill.content === 'string' && skill.content.length > 0),
  'a registered skill has no body',
)
check(
  skillRegistrations.every((skill) => skill.resourceBase?.kind === 'directory' && skill.resourceBase.path.length > 0),
  'a registered skill has no resource base',
)
// A folded `>-` description must arrive unfolded, on one line.
check(
  skillRegistrations
    .filter((skill) => skill.name.startsWith('ty-fixture') || skill.name.startsWith('syslab-fixture'))
    .every((skill) => typeof skill.description === 'string' && !skill.description.startsWith('>-') && skill.description.includes('continued on a second folded line')),
  'a fixture skill description was not unfolded from its folded block',
)
check(
  registeredNames.every((name) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)),
  'a registered skill name violates the kebab-case grammar',
)
// Names owned by other products in a shared client folder must not be claimed.
check(!registeredNames.includes(FIXTURE_SKILLS.foreign), 'a skill owned by another product was claimed')
check(
  !registeredNames.includes('diagnose-word-workfile-error') && !registeredNames.includes('wechat-chat-reader'),
  'skills owned by another product were claimed',
)

// ---- routes
for (const path of ['/api/dsh-mworks-ai/environment', '/api/dsh-mworks-ai/restart']) {
  check(routes.has(path), `route ${path} was not registered`)
}

function makeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers ?? {} },
    end(body) { state.body = body ?? '' },
  }
}

function makeRequest({ method = 'GET', headers = {}, body, omitJsonContentType = false } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.headers = {
    host: '127.0.0.1:57619',
    // The page posts JSON; omitting the type is how a cross-site simple request
    // would arrive, so the tests can ask for that shape explicitly.
    ...(body !== undefined && !omitJsonContentType ? { 'content-type': 'application/json' } : {}),
    ...headers,
  }
  if (body !== undefined) {
    request.on('data', () => {})
    setTimeout(() => {
      request.emit('data', Buffer.from(JSON.stringify(body)))
      request.emit('end')
    }, 0)
  }
  return request
}

// GET environment
{
  const response = makeResponse()
  await routes.get('/api/dsh-mworks-ai/environment').handler(makeRequest(), response)
  check(response.state.status === 200, `environment route returned ${response.state.status}`)
  const parsed = JSON.parse(response.state.body || '{}')
  check(parsed.mcp?.manager === true, 'environment route payload has no MCP state')
  check(Array.isArray(parsed.skills?.mworks), 'environment route payload has no skill list')
}

// method not allowed
{
  const response = makeResponse()
  await routes.get('/api/dsh-mworks-ai/environment').handler(makeRequest({ method: 'DELETE' }), response)
  check(response.state.status === 405, `environment route accepted DELETE (${response.state.status})`)
}

// cross-site refused
{
  const response = makeResponse()
  await routes.get('/api/dsh-mworks-ai/environment').handler(
    makeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }),
    response,
  )
  check(response.state.status === 403, `cross-site read was not refused (${response.state.status})`)
}

// ---- the Host's own access check is honoured on both routes
{
  // Every route must ask the connection service first.
  connectionSeen.length = 0
  const use = async (path, request) => {
    const response = makeResponse()
    await routes.get(path).handler(request, response)
    return response.state.status
  }

  rejection = 401
  check(await use('/api/dsh-mworks-ai/environment', makeRequest()) === 401, 'a 401 from the connection service was not propagated')
  const beforeRestart = restarted.length
  check(
    await use('/api/dsh-mworks-ai/restart', makeRequest({ method: 'POST', body: { server: 'mworks_sysplorer' } })) === 401,
    'the restart route ignored a 401 from the connection service',
  )
  check(restarted.length === beforeRestart, 'a rejected request still reached the MCP manager')

  rejection = 403
  check(await use('/api/dsh-mworks-ai/environment', makeRequest()) === 403, 'a 403 from the connection service was not propagated')
  check(
    await use('/api/dsh-mworks-ai/restart', makeRequest({ method: 'POST', body: { server: 'mworks_sysplorer' } })) === 403,
    'the restart route ignored a 403 from the connection service',
  )

  rejection = undefined
  check(await use('/api/dsh-mworks-ai/environment', makeRequest()) === 200, 'an allowed request was refused')
  check(connectionSeen.length >= 5, `the connection service was consulted ${connectionSeen.length} times for 5 requests`)
}

// a guard that throws must refuse rather than fall through
{
  const response = makeResponse()
  const throwing = { requestRejection() { throw new Error('boom') } }
  const saved = connectionService.requestRejection
  connectionService.requestRejection = throwing.requestRejection
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'connection' ? connectionService : originalGet(name))
  await routes.get('/api/dsh-mworks-ai/environment').handler(makeRequest(), response)
  connectionService.requestRejection = saved
  ctx.get = originalGet
  check(response.state.status === 403, `a throwing guard produced ${response.state.status}, expected 403`)
}

// ---- the Host's verdict is final: this plugin does not second-guess it
// A deployment that trusts a non-loopback authority (trustedHosts behind a
// proxy rewriting Host) produces exactly this shape: the Host allows it, while
// a local Origin/Host comparison would disagree. Only the Host may decide.
{
  rejection = undefined
  const response = makeResponse()
  await routes.get('/api/dsh-mworks-ai/environment').handler(
    makeRequest({ headers: { origin: 'https://harness.internal', host: 'harness.internal:8443' } }),
    response,
  )
  check(
    response.state.status === 200,
    `a Host-approved request was rejected locally (${response.state.status})`,
  )
}

// ---- without the connection service the local fallback still guards
{
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'connection' ? undefined : originalGet(name))
  const allowed = makeResponse()
  await routes.get('/api/dsh-mworks-ai/environment').handler(makeRequest(), allowed)
  const crossSite = makeResponse()
  await routes.get('/api/dsh-mworks-ai/environment').handler(
    makeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }),
    crossSite,
  )
  ctx.get = originalGet
  check(allowed.state.status === 200, `the fallback refused a same-origin request (${allowed.state.status})`)
  check(crossSite.state.status === 403, `the fallback admitted a cross-site request (${crossSite.state.status})`)
}

// a cross-site "simple request" cannot post a restart
{
  const before = restarted.length
  const response = makeResponse()
  await routes.get('/api/dsh-mworks-ai/restart').handler(
    makeRequest({ method: 'POST', body: { server: 'mworks_sysplorer' }, omitJsonContentType: true }),
    response,
  )
  check(response.state.status === 415, `a non-JSON restart POST produced ${response.state.status}, expected 415`)
  check(restarted.length === before, 'a non-JSON restart POST reached the manager')
}

// POST restart accepts a known server
{
  const response = makeResponse()
  const request = makeRequest({ method: 'POST', body: { server: 'mworks_sysplorer' } })
  await routes.get('/api/dsh-mworks-ai/restart').handler(request, response)
  check(response.state.status === 200, `restart route returned ${response.state.status}`)
  check(restarted.includes('mworks_sysplorer'), 'restart route did not ask the manager to restart')
  const parsed = JSON.parse(response.state.body || '{}')
  check(parsed.ok === true && parsed.mcp?.manager === true, 'restart route did not return fresh state')
}

// POST restart rejects an unknown server without touching the manager
{
  const before = restarted.length
  const response = makeResponse()
  await routes.get('/api/dsh-mworks-ai/restart').handler(
    makeRequest({ method: 'POST', body: { server: '../../etc/passwd' } }),
    response,
  )
  check(response.state.status === 400, `unknown server was not rejected (${response.state.status})`)
  check(restarted.length === before, 'unknown server reached the manager')
}

// restart tool
{
  const tool = tools.get('mworks_mcp_restart')
  const before = restarted.length
  const result = await tool.execute({ server: 'mworks_syslab' })
  check(result.ok === true, `restart tool returned ${JSON.stringify(result)}`)
  check(restarted.length === before + 1 && restarted.at(-1) === 'mworks_syslab', 'restart tool did not restart the named server')
}

// ---- independence: the plugin supplies its skills whatever else is mounted
// Deferring to another provider would make availability depend on a component
// this bundle does not own, so the check is that a foreign provider serving the
// same names changes nothing.
{
  const served = [FIXTURE_SKILLS.modeling, FIXTURE_SKILLS.syslab]
  registrySkills = served.map((name) => ({ name, description: 'served elsewhere' }))

  const localListeners = new Set()
  const localRegistrations = []
  const localService = {
    async list() { return registrySkills },
    register(skill) {
      localRegistrations.push(skill)
      return () => {
        const index = localRegistrations.findIndex((entry) => entry.name === skill.name)
        if (index >= 0) localRegistrations.splice(index, 1)
      }
    },
  }
  const localCtx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (service) => (service === 'skills' ? localService : undefined),
    effect(fn) {
      const cleanup = fn()
      return () => { if (typeof cleanup === 'function') cleanup() }
    },
    on(name, callback) {
      if (name !== 'skills/change') return () => {}
      localListeners.add(callback)
      return () => localListeners.delete(callback)
    },
    inject(names, callback) {
      callback({ ...localCtx, skills: localService, webServer: { register: () => () => {} } })
      return () => {}
    },
  }

  plugin.apply(localCtx, {})
  await new Promise((resolve) => setTimeout(resolve, 50))
  const contributed = localRegistrations.map((skill) => skill.name)
  check(contributed.includes(FIXTURE_SKILLS.modeling), 'a foreign provider suppressed the modeling skill')
  check(contributed.includes(FIXTURE_SKILLS.syslab), 'a foreign provider suppressed the Syslab skill')
  check(
    localRegistrations.find((skill) => skill.name === FIXTURE_SKILLS.modeling)?.resourceBase?.path
      .startsWith(FIXTURE_PATHS.sysplorer),
    'the contributed skill is not the installation copy',
  )

  // The other provider going away must change nothing.
  registrySkills = []
  for (const callback of localListeners) callback()
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(
    localRegistrations.filter((skill) => skill.name === FIXTURE_SKILLS.modeling).length === 1,
    'the contribution did not survive a provider disappearing',
  )

  // A bundle deleted from disk must be released, not kept alive by our entry.
  rmSync(join(FIXTURE_PATHS.sysplorer, 'Tools', 'sysplorer_mcp', 'resources', 'modeling_skills', FIXTURE_SKILLS.modeling), { recursive: true, force: true })
  for (const callback of localListeners) callback()
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(
    !localRegistrations.map((skill) => skill.name).includes(FIXTURE_SKILLS.modeling),
    'a bundle deleted from disk stayed registered',
  )

  // Restore the fixture for the discovery test that follows.
  writeSkill(join(FIXTURE_PATHS.sysplorer, 'Tools', 'sysplorer_mcp', 'resources', 'modeling_skills'), FIXTURE_SKILLS.modeling, 'Fixture modeling rules for the host check.')
  registrySkills = []
}

// ---- release tolerance: a newer release, a renamed payload, and a pre-AI one
{
  // A future release is just another directory name; discovery is version-agnostic.
  const future = join(FIXTURE, 'Sysplorer 2027a')
  mkdirSync(join(future, 'Tools', 'sysplorer_mcp'), { recursive: true })
  writeFileSync(join(future, 'Tools', 'sysplorer_mcp', 'main.py'), '# future launcher\n')
  mkdirSync(join(future, 'External', 'python64'), { recursive: true })
  writeFileSync(join(future, 'External', 'python64', process.platform === 'win32' ? 'python.exe' : 'python'), '')
  const detectedFuture = plugin.detectInstallation({ sysplorerRoot: future })
  check(detectedFuture.sysplorer.installed === true, 'a future release directory was not detected')
  check(detectedFuture.sysplorer.ai.supported === true, 'a future release was treated as having no AI payload')

  // A release that renames the tool directory must still resolve.
  const renamed = join(FIXTURE, 'Sysplorer renamed')
  mkdirSync(join(renamed, 'Tools', 'sysplorer-mcp-toolkit'), { recursive: true })
  writeFileSync(join(renamed, 'Tools', 'sysplorer-mcp-toolkit', 'main.py'), '# renamed launcher\n')
  mkdirSync(join(renamed, 'External', 'python3'), { recursive: true })
  writeFileSync(join(renamed, 'External', 'python3', process.platform === 'win32' ? 'python.exe' : 'python'), '')
  const detectedRenamed = plugin.detectInstallation({ sysplorerRoot: renamed })
  check(detectedRenamed.sysplorer.mcpLauncher !== undefined, 'a renamed MCP tool directory was not found')
  check(detectedRenamed.sysplorer.ai.supported === true, 'a renamed payload was not recognised')

  // A release that predates the AI integration: installed, no payload, no server.
  const preAi = join(FIXTURE, 'Sysplorer 2025a')
  mkdirSync(join(preAi, 'Bin64'), { recursive: true })
  const detectedPreAi = plugin.detectInstallation({ sysplorerRoot: preAi })
  check(detectedPreAi.sysplorer.installed === true, 'a pre-AI release is not reported as installed')
  check(detectedPreAi.sysplorer.ai.supported === false, 'a pre-AI release claims AI support')
  check(detectedPreAi.sysplorer.ai.missing.length > 0, 'a pre-AI release reports no reason')
  check(
    plugin.resolveServers(detectedPreAi, FIXTURE_PATHS.workspace).every((server) => server.serverName !== 'mworks_sysplorer'),
    'a pre-AI release contributed an MCP server it cannot run',
  )
  const preAiGuidance = plugin.guidanceText(detectedPreAi)
  check(
    preAiGuidance.includes('Sysplorer 2025a') && /predates the MWORKS AI integration/.test(preAiGuidance),
    'the instructions do not explain that this release has no AI tooling',
  )
  check(
    !preAiGuidance.includes('For Sysplorer work, call'),
    'the instructions still tell the agent to call a tool that does not exist',
  )
}
{
  const before = skillRegistrations.length
  plugin.apply({
    ...ctx,
    get: () => undefined,
    inject(names, callback) {
      // No MCP manager here, but the plugin still expects the full context shape.
      callback({ ...ctx, skills: skillsService, webServer: { register: () => () => {} } })
      return () => {}
    },
  }, { registerSkills: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  check(skillRegistrations.length === before, 'registerSkills: false still registered skills')
  check(
    logs.info.some((line) => line.includes('skill contribution disabled')),
    'registerSkills: false did not say so in the log',
  )
}

// ---- discovery is driven purely by the roots it is given
{
  const installationRoot = join(FIXTURE_PATHS.sysplorer, 'Tools', 'sysplorer_mcp', 'resources', 'modeling_skills')
  const syslabRoot = join(FIXTURE_PATHS.syslab, 'Tools', 'syslab-skills')
  // A shared client folder: MWORKS names are taken, anything else is left alone.
  const sharedRoot = join(FIXTURE, 'shared-skills')
  writeSkill(sharedRoot, FIXTURE_SKILLS.foreign, 'Belongs to another product; must never be claimed.')
  writeSkill(sharedRoot, 'ty-fixture-from-shared', 'An MWORKS skill that only a client folder has.')

  const roots = [
    { path: installationRoot, authoritative: true },
    { path: syslabRoot, authoritative: true },
    { path: sharedRoot, authoritative: false },
  ]
  const bundles = plugin.discoverSkillBundlesIn(roots)
  const names = bundles.map((bundle) => bundle.name)
  check(names.includes(FIXTURE_SKILLS.modeling), 'the modeling skill was not discovered')
  check(names.includes(FIXTURE_SKILLS.syslab), 'the Syslab skill was not discovered')
  check(names.includes('ty-fixture-from-shared'), 'an MWORKS skill in a shared folder was not discovered')
  check(!names.includes(FIXTURE_SKILLS.foreign), 'a non-MWORKS skill in a shared folder was claimed')
  check(
    bundles.find((bundle) => bundle.name === FIXTURE_SKILLS.modeling)?.description.includes('continued on a second folded line'),
    'folded description was not unfolded',
  )
  // The first root that declares a name wins.
  writeSkill(sharedRoot, FIXTURE_SKILLS.modeling, 'A stale copy from a client folder.')
  const shadowed = plugin.discoverSkillBundlesIn(roots).find((bundle) => bundle.name === FIXTURE_SKILLS.modeling)
  check(
    shadowed !== undefined && shadowed.dir.startsWith(installationRoot),
    'a stale client-folder copy shadowed the installation copy',
  )
  // A missing root is not an error.
  check(
    plugin.discoverSkillBundlesIn([{ path: join(FIXTURE, 'does-not-exist'), authoritative: true }]).length === 0,
    'a missing root produced bundles',
  )
}

// ---- disposal releases the registrations
check(cleanups.length >= 2, 'plugin registered no cleanups')
const summary = {
  servers: registrations.map((r) => r.name),
  tools: [...tools.keys()],
  routes: [...routes.keys()],
}
for (const cleanup of cleanups) {
  if (typeof cleanup === 'function') cleanup()
}
check(registrations.length === 0, 'disposal left MCP registrations behind')
check(tools.size === 0, 'disposal left tools registered')

rmSync(FIXTURE, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('host check FAILED')
  for (const failure of failures) console.error('  -', failure)
  process.exit(1)
}

console.log('host check OK')
console.log('  MCP servers :', summary.servers.join(', '))
console.log('  tools       :', summary.tools.join(', '))
console.log('  routes      :', summary.routes.join(', '))
console.log('  status      : connected / reconnecting mapped, unmanaged handled')
console.log('  guard       : 405 on wrong method, 403 cross-site, 400 unknown server')
console.log('  paths       : resolved from the fixture, no machine path in lib/index.js')
console.log('  skills      : contributed regardless of other providers, released when deleted')
console.log('  disposal    : registrations and tools released')
