/**
 * Check the bundle's display metadata against the DSH plugin display checklist:
 * one image per detail document, image dimensions, no script/style/text, and a
 * 36x36 icon. Run with node from any directory.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const problems = []

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
if (pkg.dsh?.bundle?.patch === undefined) problems.push('package.json has no dsh.bundle.patch')

for (const exported of ['./client', './locale/*.json', './icon']) {
  if (pkg.exports?.[exported] === undefined) problems.push(`package.json does not export ${exported}`)
}

const FORBIDDEN = /<text[\s>]|<style[\s>]|<script[\s>]|foreignObject/

function checkImage(path, label) {
  if (!existsSync(path)) {
    problems.push(`${label}: missing ${path}`)
    return
  }
  const svg = readFileSync(path, 'utf8')
  if (svg.length > 256 * 1024) problems.push(`${label}: ${path} exceeds the 256 KiB icon limit`)
  if (FORBIDDEN.test(svg)) problems.push(`${label}: ${path} contains text/style/script/foreignObject`)
  return svg
}

const icon = checkImage(join(ROOT, 'icon.svg'), 'icon')
if (icon !== undefined && !(icon.includes('width="36"') && icon.includes('height="36"'))) {
  problems.push('icon.svg is not 36x36')
}

for (const locale of ['en', 'zh']) {
  const dict = JSON.parse(readFileSync(join(ROOT, 'locale', `${locale}.json`), 'utf8'))
  const meta = dict.meta ?? {}
  if (typeof meta.title !== 'string' || meta.title.length === 0) problems.push(`${locale}: no meta.title`)
  if (typeof meta.description !== 'string' || meta.description.length < 120) {
    problems.push(`${locale}: meta.description is too short to explain the plugin`)
  }
  if (typeof meta.detail !== 'string') continue

  const documentPath = join(ROOT, meta.detail)
  if (!existsSync(documentPath)) {
    problems.push(`${locale}: detail document missing: ${meta.detail}`)
    continue
  }
  const lines = readFileSync(documentPath, 'utf8').split('\n').filter((line) => line.trim().length > 0)
  const imageLines = lines.filter((line) => line.trim().startsWith('!['))
  if (lines.length !== 1 || imageLines.length !== 1) {
    problems.push(`${locale}: ${meta.detail} must contain exactly one image line, got ${lines.length} lines / ${imageLines.length} images`)
    continue
  }
  const match = /!\[[^\]]+\]\(([^)]+)\)/.exec(imageLines[0])
  if (match === null) {
    problems.push(`${locale}: ${meta.detail} has malformed image syntax`)
    continue
  }
  const imagePath = join(ROOT, 'docs', match[1])
  const svg = checkImage(imagePath, `${locale} preview`)
  if (svg !== undefined && !(svg.includes('width="640"') && svg.includes('height="300"'))) {
    problems.push(`${locale}: preview ${match[1]} is not 640x300`)
  }
}

const en = JSON.parse(readFileSync(join(ROOT, 'locale/en.json'), 'utf8'))
const zh = JSON.parse(readFileSync(join(ROOT, 'locale/zh.json'), 'utf8'))
if (en.meta.title !== zh.meta.title) {
  problems.push(`meta.title differs between locales: ${en.meta.title} / ${zh.meta.title}`)
}

if (problems.length > 0) {
  console.error('metadata FAILED')
  for (const problem of problems) console.error('  -', problem)
  process.exit(1)
}

console.log('metadata OK')
console.log('  bundle      :', pkg.name, pkg.version)
console.log('  title       :', en.meta.title)
console.log('  detail en/zh:', en.meta.detail, '/', zh.meta.detail)
console.log('  description :', en.meta.description.length, 'chars (en),', zh.meta.description.length, 'chars (zh)')
