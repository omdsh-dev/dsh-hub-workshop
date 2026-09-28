#!/usr/bin/env node

import { cp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TARGET = resolve(ROOT, '.public-site')
import { PUBLIC_FILES as FILES } from './public-assets.mjs'
import { marketplaceAssets } from './marketplace-assets.mjs'
const generated = marketplaceAssets(JSON.parse(await readFile(resolve(ROOT, 'marketplace.json'), 'utf8')))

await rm(TARGET, { recursive: true, force: true })
for (const path of FILES) {
  const target = resolve(TARGET, path)
  await mkdir(dirname(target), { recursive: true })
  if (generated.has(path)) {
    await writeFile(target, JSON.stringify(generated.get(path)) + '\n')
  } else if (path.endsWith('.json')) {
    await writeFile(target, JSON.stringify(JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))) + '\n')
  } else {
    await cp(resolve(ROOT, path), target)
  }
  if ((await stat(target)).size > 25 * 1024 * 1024) throw new Error(`Public asset exceeds Cloudflare's per-file limit: ${path}`)
}
console.log(`built public site with ${FILES.length} allowlisted files`)
