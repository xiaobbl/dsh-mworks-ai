/**
 * Cross-check that every class name the components use exists in the injected
 * stylesheet, and that every rule in the stylesheet is actually used. Catches
 * the dangling-class mistakes a stylesheet rewrite tends to leave behind.
 *
 * Not shipped with the bundle.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const source = readFileSync(`${ROOT}client.js`, 'utf8')

// Classes built through string concatenation are counted by their literal parts.
const used = new Set()
for (const match of source.matchAll(/className:\s*'([^']*)'/g)) {
  for (const name of match[1].split(/\s+/)) if (name.length > 0) used.add(name)
}
for (const match of source.matchAll(/'(mworksai-[a-z-]+)'/g)) used.add(match[1])
// Health-dot classes are assembled in a lookup table, so their values count.
const dotBlock = /var DOT_CLASSES = \{([\s\S]*?)\n    \}/.exec(source)
if (dotBlock !== null) {
  for (const match of dotBlock[1].matchAll(/'(mworksai-[a-z -]+)'/g)) {
    for (const name of match[1].split(/\s+/)) if (name.length > 0) used.add(name)
  }
}

const cssBlock = /var CSS = \[([\s\S]*?)\]\.join\('\\n'\)/.exec(source)
if (cssBlock === null) {
  console.error('could not locate the stylesheet block')
  process.exit(1)
}
const defined = new Set()
for (const match of cssBlock[1].matchAll(/\.(mworksai-[a-z-]+)/g)) defined.add(match[1])

const missing = [...used].filter((name) => name.startsWith('mworksai-') && !defined.has(name))
const unused = [...defined].filter((name) => !used.has(name))

const problems = []
if (missing.length > 0) problems.push(`used but not defined: ${missing.join(', ')}`)
if (unused.length > 0) problems.push(`defined but never used: ${unused.join(', ')}`)

if (problems.length > 0) {
  console.error('class check FAILED')
  for (const problem of problems) console.error('  -', problem)
  process.exit(1)
}

console.log('class check OK')
console.log('  used classes     :', used.size)
console.log('  defined selectors:', defined.size)
