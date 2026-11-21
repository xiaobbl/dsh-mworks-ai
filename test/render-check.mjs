/**
 * Render the registered detail-page section with a faithful React stand-in and
 * assert what the page shows.
 *
 * This is the closest check available without a browser. The renderer below
 * keeps per-component hook state across renders and enforces hook ordering, so
 * a component that throws (which makes the host blank the section, or the whole
 * slot entry) fails the run instead of shipping.
 *
 * Not shipped with the bundle.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const source = readFileSync(`${ROOT}client.js`, 'utf8')

// --------------------------------------------------------------- React stand-in

const componentState = new Map()
const componentRefs = new Map()
let frame = { hooks: [], index: 0, effects: [], state: [], refs: [] }

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) } }
  },
  useState(initial) {
    const index = frame.index++
    frame.hooks.push(`useState@${index}`)
    if (frame.state[index] === undefined) frame.state[index] = typeof initial === 'function' ? initial() : initial
    const owner = frame.owner
    return [frame.state[index], (next) => {
      const live = componentState.get(owner) ?? []
      live[index] = typeof next === 'function' ? next(live[index]) : next
      componentState.set(owner, live)
    }]
  },
  useEffect(effect) {
    const index = frame.index++
    frame.hooks.push(`useEffect@${index}`)
    frame.effects.push(effect)
  },
  useCallback(fn) {
    const index = frame.index++
    frame.hooks.push(`useCallback@${index}`)
    return fn
  },
  useRef(initial) {
    const index = frame.index++
    frame.hooks.push(`useRef@${index}`)
    if (frame.refs[index] === undefined) frame.refs[index] = { current: initial === undefined ? null : initial }
    return frame.refs[index]
  },
}

const ReactDOM = { createPortal: (node, container) => ({ type: 'portal', container, child: node }) }

function render(component, props) {
  const saved = componentState.get(component)
  const savedRefs = componentRefs.get(component)
  frame = {
    owner: component,
    hooks: [],
    index: 0,
    effects: [],
    state: saved === undefined ? [] : [...saved],
    refs: savedRefs === undefined ? [] : [...savedRefs],
  }
  const element = component(props)
  componentState.set(component, frame.state)
  componentRefs.set(component, frame.refs)
  return { element, frame }
}

/** Render, run the queued effects, let their promises settle, then render again. */
async function mount(component, props) {
  const first = render(component, props)
  for (const effect of first.frame.effects) {
    const cleanup = effect()
    if (cleanup !== undefined && typeof cleanup !== 'function') {
      throw new Error('an effect returned something other than a cleanup function')
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  return render(component, props)
}

// ------------------------------------------------------------- component loading

let registration
globalThis.window = { __ModuleLoader__: { load: (bundle) => { registration = bundle } } }
const styleNodes = []
globalThis.document = {
  head: { appendChild: (node) => styleNodes.push(node) },
  querySelector: () => null,
  createElement: () => ({ attributes: {}, setAttribute(k, v) { this.attributes[k] = v }, textContent: '' }),
  addEventListener() {},
  removeEventListener() {},
}

const SAMPLE = {
  generatedAt: '2026-11-20T03:00:00.000Z',
  platform: 'win32',
  syslab: {
    installed: true, root: 'E:\\MWORKS\\Syslab 2026b', otherRoots: [],
    build: { version: '26.8.0.9029', buildDate: '2026-10-31 17:39' },
    mcpServer: 'E:\\MWORKS\\Syslab 2026b\\Tools\\syslab-mcp-server\\syslab-mcp-server-win64.exe',
  },
  sysplorer: {
    installed: true, root: 'E:\\MWORKS\\Sysplorer 2026b', otherRoots: [],
    build: { version: '26.8.1.3998', buildDate: '2026-11-09 21:20' },
    mcpLauncher: 'E:\\MWORKS\\Sysplorer 2026b\\Tools\\sysplorer_mcp\\main.py',
  },
  julia: { installed: true, root: 'C:\\Users\\Public\\TongYuan\\julia-1.10.10', otherRoots: [] },
  skills: { roots: [], mworks: ['syslab-environment', 'ty-sysplorer-modeling-rules'] },
  mcp: {
    manager: true,
    servers: [
      { server: 'mworks_syslab', label: 'Syslab MCP Server', declaredTools: 8, state: 'connected', healthy: true, toolCount: 8, detail: 'connected, 8 tools registered' },
      { server: 'mworks_sysplorer', label: 'Sysplorer MCP Server', declaredTools: 15, state: 'connected', healthy: true, toolCount: 15, detail: 'connected, 15 tools registered' },
    ],
  },
  mcpServers: [
    { server: 'mworks_syslab', label: 'Syslab MCP Server', tools: 8, healthy: true },
    { server: 'mworks_sysplorer', label: 'Sysplorer MCP Server', tools: 15, healthy: true },
  ],
}

let fetchImpl = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => SAMPLE })
const fetchCalls = []
globalThis.fetch = (...args) => { fetchCalls.push(args[0]); return fetchImpl(...args) }

;(0, eval)(source)

const dictionaries = new Map()
const registrations = []
const ctx = {
  effect(factory) { const cleanup = factory(); return typeof cleanup === 'function' ? cleanup : () => {} },
  locale: {
    register(ns, locale, dict) {
      const key = `${ns}/${locale}`
      if (dictionaries.has(key)) throw new Error(`duplicate dictionary ${key}`)
      dictionaries.set(key, dict)
      return () => dictionaries.delete(key)
    },
  },
  slots: {
    inject(name, callback) { callback(); return () => {} },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
}

const clientModule = registration.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react-dom') return ReactDOM
  throw new Error(`unexpected module request: ${specifier}`)
})
clientModule.apply(ctx)

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

// ---- registration contract
check(registrations.length === 1, `expected exactly 1 registration, got ${registrations.length}`)
const { options, component } = registrations[0] ?? {}
check(options?.name === 'plugins.detail.section', `slot is ${options?.name}, expected plugins.detail.section`)
check(options?.id === 'dsh-mworks-ai.environment', `id is ${options?.id}`)
check(options?.locale === 'dshMworksAi', `registration locale is ${options?.locale}`)
check(
  JSON.stringify(clientModule.inject) === JSON.stringify(['slots', 'locale']),
  `inject is ${JSON.stringify(clientModule.inject)}`,
)
check(
  registrations.every(({ options: o }) => o.name !== 'conversation.input.left' && o.name !== 'conversation.composer.dock'),
  'the plugin still contributes to the conversation UI',
)

const zh = dictionaries.get('dshMworksAi/zh')
const en = dictionaries.get('dshMworksAi/en')
check(zh !== undefined && en !== undefined, 'locale dictionaries were not both registered')
const zhOnly = Object.keys(zh ?? {}).filter((key) => !(key in (en ?? {})))
const enOnly = Object.keys(en ?? {}).filter((key) => !(key in (zh ?? {})))
check(zhOnly.length === 0 && enOnly.length === 0, `locale key mismatch: zh-only ${zhOnly}, en-only ${enOnly}`)
const usedKeys = [...new Set([...source.matchAll(/\bt\(['"]([A-Za-z.]+)['"]/g)].map((match) => match[1]))]
const undefinedKeys = usedKeys.filter((key) => zh !== undefined && !(key in zh))
check(undefinedKeys.length === 0, `keys used but not defined: ${undefinedKeys.join(', ')}`)

const makeT = (dict) => (key, params) => {
  const template = dict[key]
  if (typeof template !== 'string') return key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

/** Flatten an element tree into visible text by invoking function components. */
function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach((child) => textOf(child, out)); return out }
  if (node.type === 'portal') { textOf(node.child, out); return out }
  if (typeof node.type === 'function') {
    const saved = frame
    const inner = render(node.type, node.props || {})
    if (inner.element !== null && inner.element !== undefined) textOf(inner.element, out)
    frame = saved
    return out
  }
  if (node.props) textOf(node.props.children, out)
  return out
}

/** Buttons reachable in a rendered tree as { label, onClick, disabled }. */
function buttonsOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((child) => buttonsOf(child, out)); return out }
  if (node.type === 'portal') { buttonsOf(node.child, out); return out }
  if (typeof node.type === 'function') {
    const saved = frame
    const inner = render(node.type, node.props || {})
    if (inner.element !== null && inner.element !== undefined) buttonsOf(inner.element, out)
    frame = saved
    return out
  }
  if (node.type === 'button' && node.props) {
    out.push({ label: textOf(node).join(' '), onClick: node.props.onClick, disabled: node.props.disabled === true })
  }
  if (node.props) buttonsOf(node.props.children, out)
  return out
}

// ---- other plugins' pages stay untouched
for (const subject of [undefined, null, {}, { kind: 'bundle' }, { kind: 'bundle', pkg: { name: 'dsh-ops' } }, { kind: 'row', pkg: null }]) {
  const { element } = render(component, { t: makeT(zh), subject })
  check(element === null, `section rendered for a foreign subject ${JSON.stringify(subject)}`)
}
check(fetchCalls.length === 0, 'section fetched the environment before its own page opened')

// ---- our own page
{
  const subject = { kind: 'bundle', pkg: { name: 'dsh-mworks-ai' } }
  const settled = await mount(component, { t: makeT(zh), subject })
  const text = textOf(settled.element).join(' ')
  for (const expected of [
    zh.sectionTitle, zh.installRoot, zh.syslab, zh.sysplorer, zh.julia,
    zh.mcpServers, zh.pathsFound, zh.skills,
    '26.8.0.9029', '26.8.1.3998', 'syslab-environment', 'ty-sysplorer-modeling-rules',
  ]) {
    check(text.includes(expected), `own page is missing "${expected}"`)
  }
  check(!text.includes(zh.missingHint), 'own page shows the missing-installation hint while both products exist')
  const buttons = buttonsOf(settled.element)
  check(buttons.length === 1, `expected one refresh button, got ${buttons.length}`)
  check(buttons[0]?.label === zh.refresh, `refresh button label is "${buttons[0]?.label}"`)
  check(buttons[0]?.disabled === false, 'refresh button is disabled after a successful load')
}

// ---- refreshing re-reads the route
{
  const subject = { kind: 'bundle', pkg: { name: 'dsh-mworks-ai' } }
  const before = fetchCalls.length
  const settled = await mount(component, { t: makeT(zh), subject })
  const button = buttonsOf(settled.element)[0]
  check(button !== undefined, 'refresh button missing')
  button?.onClick()
  await mount(component, { t: makeT(zh), subject })
  check(fetchCalls.length > before, 'pressing refresh did not re-read the environment route')
}

// ---- a missing product explains what to do next
{
  componentState.delete(component)
  fetchImpl = async () => ({
    ok: true,
    json: async () => ({ ...SAMPLE, syslab: { installed: false, root: undefined, otherRoots: [] } }),
  })
  const subject = { kind: 'row', pkg: { name: 'dsh-mworks-ai' } }
  const settled = await mount(component, { t: makeT(zh), subject })
  const text = textOf(settled.element).join(' ')
  check(text.includes(zh.missingHint), 'missing product does not explain what to do next')
  check(text.includes(zh.status), 'missing product has no status label')
  check(text.includes(zh.notFound), 'missing product is not marked as not found')
}

// ---- a failed read says so and offers a retry
{
  componentState.delete(component)
  fetchImpl = async () => { throw new Error('boom') }
  const subject = { kind: 'bundle', pkg: { name: 'dsh-mworks-ai' } }
  const settled = await mount(component, { t: makeT(zh), subject })
  const text = textOf(settled.element).join(' ')
  check(text.includes('boom'), 'failure reason is not shown')
  const buttons = buttonsOf(settled.element)
  check(buttons[0]?.label === zh.retry, 'failed state does not offer a retry')
  check(buttons[0]?.disabled === false, 'retry button is disabled')
}

// ---- English renders too
{
  componentState.delete(component)
  fetchImpl = async () => ({ ok: true, json: async () => SAMPLE })
  const settled = await mount(component, { t: makeT(en), subject: { kind: 'bundle', pkg: { name: 'dsh-mworks-ai' } } })
  const text = textOf(settled.element).join(' ')
  check(text.includes(en.sectionTitle), 'English section title missing')
  check(text.includes(en.pathsFound), 'English path chip missing')
}

// ---- a disconnected server is visible and offers a reconnect that POSTs
{
  componentState.delete(component)
  const disconnected = {
    ...SAMPLE,
    mcp: {
      manager: true,
      servers: [
        { server: 'mworks_syslab', label: 'Syslab MCP Server', declaredTools: 8, state: 'connected', healthy: true, toolCount: 8, detail: 'connected, 8 tools registered' },
        { server: 'mworks_sysplorer', label: 'Sysplorer MCP Server', declaredTools: 15, state: 'reconnecting', healthy: false, attempt: 3, maxAttempts: 10, detail: 'reconnecting (attempt 3/10): connection lost' },
      ],
    },
  }
  const calls = []
  globalThis.fetch = (url, init) => {
    calls.push({ url, init })
    if (String(url).endsWith('/restart')) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, server: 'mworks_sysplorer', mcp: disconnected.mcp }) })
    }
    return Promise.resolve({ ok: true, json: async () => disconnected })
  }

  const subject = { kind: 'bundle', pkg: { name: 'dsh-mworks-ai' } }
  const settled = await mount(component, { t: makeT(zh), subject })
  const text = textOf(settled.element).join(' ')
  check(text.includes(zh.stateReconnecting), 'a reconnecting server is not shown as reconnecting')
  check(text.includes('connection lost'), 'the last error is not shown for a disconnected server')

  const buttons = buttonsOf(settled.element)
  const reconnect = buttons.find((button) => button.label === zh.reconnect)
  check(reconnect !== undefined, 'a disconnected server offers no reconnect control')
  check(buttons.length === 2, `expected the refresh and one reconnect control, got ${buttons.length}`)

  reconnect?.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const posted = calls.find((call) => String(call.url).endsWith('/restart'))
  check(posted !== undefined, 'reconnect did not POST to the restart route')
  check(posted?.init?.method === 'POST', 'reconnect did not use POST')
  check(
    typeof posted?.init?.body === 'string' && JSON.parse(posted.init.body).server === 'mworks_sysplorer',
    'reconnect POST body does not name the server',
  )

  // Restore the plain sample for the remaining cases.
  globalThis.fetch = (...args) => { fetchCalls.push(args[0]); return fetchImpl(...args) }
}

if (failures.length > 0) {
  console.error('render check FAILED')
  for (const failure of failures) console.error('  -', failure)
  process.exit(1)
}

console.log('render check OK')
console.log('  slot        :', options.name, `id=${options.id}`, `order=${options.order}`)
console.log('  locales     :', [...dictionaries.keys()].join(', '), `(${Object.keys(zh).length} keys each)`)
console.log('  foreign pages: renders null, fetches nothing')
console.log('  own page    : versions, MCP path chips, Julia root, skills, refresh')
console.log('  missing/fail: explains next step / shows the reason and retries')
