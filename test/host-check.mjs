/**
 * Host-half check: the MCP registration, the three tools, the prompt section,
 * and both routes.
 *
 * The MCP servers are contributed through `mcpManager.register()`, so this test
 * pins that contract: names, entry fields, cleanup, and the status mapping that
 * turns manager state into what the agent and the page report.
 *
 * Not shipped with the bundle.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const plugin = await import(`file:///${ROOT.replace(/\\/g, '/')}lib/index.js`)

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

const ctx = {
  logger: {
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
  },
  get: (name) => (name === 'mcpManager' ? manager : undefined),
  effect(fn) {
    const cleanup = fn()
    cleanups.push(cleanup)
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  inject(names, callback) {
    // Both services exist in this fake profile.
    const scoped = {
      ...ctx,
      mcpManager: manager,
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
  String(byName.get('mworks_sysplorer')?.args?.[0] ?? '').endsWith('sysplorer_mcp\\main.py'),
  'Sysplorer must start through the launcher main.py, not the inner one',
)
check(
  (byName.get('mworks_syslab')?.args ?? []).includes('--syslab-display-mode=nodesktop'),
  'Syslab must run nodesktop',
)

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
const environment = plugin.detectEnvironment(ctx)
check(typeof environment.generatedAt === 'string', 'environment has no timestamp')
check(environment.mcp?.manager === true, 'environment report has no live MCP block')
check(Array.isArray(environment.mcpServers) && environment.mcpServers.length === 2, 'environment report has no server summary')
check(Array.isArray(environment.skills?.mworks), 'environment report has no skill list')

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

function makeRequest({ method = 'GET', headers = {}, body } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.headers = { host: '127.0.0.1:57619', ...headers }
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
  routes.get('/api/dsh-mworks-ai/environment').handler(makeRequest(), response)
  check(response.state.status === 200, `environment route returned ${response.state.status}`)
  const parsed = JSON.parse(response.state.body || '{}')
  check(parsed.mcp?.manager === true, 'environment route payload has no MCP state')
}

// method not allowed
{
  const response = makeResponse()
  routes.get('/api/dsh-mworks-ai/environment').handler(makeRequest({ method: 'DELETE' }), response)
  check(response.state.status === 405, `environment route accepted DELETE (${response.state.status})`)
}

// cross-site refused
{
  const response = makeResponse()
  routes.get('/api/dsh-mworks-ai/environment').handler(
    makeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }),
    response,
  )
  check(response.state.status === 403, `cross-site read was not refused (${response.state.status})`)
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
console.log('  disposal    : registrations and tools released')
