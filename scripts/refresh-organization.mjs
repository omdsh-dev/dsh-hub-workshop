#!/usr/bin/env node
import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder("ipv4first");
import { readFile, writeFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'

const path = resolve(import.meta.dirname, '../public-discovery.json')
const repositories = []
for (let page = 1; ; page++) {
  let rows
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`https://api.github.com/orgs/omdsh-dev/repos?type=public&per_page=100&page=${page}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'DSH-Hub-Discovery', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
        signal: AbortSignal.timeout(20000),
      })
      if (!response.ok) throw new Error(`Organization discovery HTTP ${response.status}`)
      rows = await response.json()
      if (!Array.isArray(rows)) throw new Error('Invalid organization repository response')
      break
    } catch (error) { if (attempt === 2) throw error }
  }
  repositories.push(...rows.filter(r => r.private === false && r.visibility === 'public' && r.owner?.login?.toLowerCase() === 'omdsh-dev').map(r => ({
    name: r.name, url: r.html_url, kind: r.name === '.github' ? 'organization-config' : 'public-project',
  })))
  if (rows.length < 100) break
}
repositories.sort((a, b) => a.name.localeCompare(b.name))
const discovery = JSON.parse(await readFile(path, 'utf8'))
discovery.organization = {
  ...discovery.organization,
  checkedAt: new Date().toISOString(),
  observedRepositoryCount: repositories.length,
  projectCount: repositories.filter(r => r.kind === 'public-project').length,
  repositories,
}
await writeFile(path + '.tmp', JSON.stringify(discovery, null, 2) + '\n')
await rename(path + '.tmp', path)
console.log(`Organization refreshed: ${repositories.length} public repositories`)
