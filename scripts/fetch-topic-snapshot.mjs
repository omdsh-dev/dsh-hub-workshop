#!/usr/bin/env node
import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder("ipv4first");

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  COMMUNITY_PLUGIN_CREATED_AT_CUTOFF,
  OFFICIAL_REPOSITORY_OWNERS,
  isRetiredRepositoryOwner,
} from './topic-admission-policy.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const TOPIC = 'dsh-plugin'
const USER_AGENT = 'omdsh-workshop-topic-refresh/2.0'
const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim() || ''
const REQUEST_INTERVAL_MS = GITHUB_TOKEN ? 2_200 : 6_500
const decoder = new TextDecoder()
let lastRequestAt = 0

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))

async function search(query, page, attempt = 0) {
  const elapsed = Date.now() - lastRequestAt
  if (elapsed < REQUEST_INTERVAL_MS) await wait(REQUEST_INTERVAL_MS - elapsed)
  const url = new URL('https://api.github.com/search/repositories')
  url.searchParams.set('q', query)
  url.searchParams.set('per_page', '100')
  url.searchParams.set('page', String(page))
  url.searchParams.set('sort', 'updated')
  url.searchParams.set('order', 'desc')
  lastRequestAt = Date.now()
  try {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
      ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
  })
  if (!response.ok) {
    const body = decoder.decode((await response.arrayBuffer()).slice(0, 800))
    throw new Error(`GitHub Search HTTP ${response.status}: ${body}`)
  }
  const value = await response.json()
  if (value.incomplete_results) throw new Error(`GitHub Search returned incomplete results for ${query}`)
  return value
  } catch (error) {
    if (attempt >= 4) throw error
    process.stderr.write(`Retrying GitHub search (${attempt + 1}/4): ${query} page ${page}\n`)
    await wait(Math.min(2000 * 2 ** attempt, 20000))
    return search(query, page, attempt + 1)
  }
}

function searchInstant(milliseconds) {
  return new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString().replace('.000Z', 'Z')
}

function lastSecondBeforeNextUtcMidnight() {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - 1_000
}

function rangeQuery(start, end) {
  return `topic:${TOPIC} created:${searchInstant(start)}..${searchInstant(end)}`
}

// GitHub Search exposes at most 1,000 results for any one query. The Topic can
// grow past that limit in hours, so fixed "yesterday/today" buckets are not a
// completeness guarantee. Probe a half-open creation-time range and bisect it
// until every leaf query is independently below the cap. GitHub supports one
// inclusive range qualifier, so adjacent partitions advance by one second to
// remain non-overlapping without dropping a boundary timestamp.
const checkpointPath = resolve(ROOT, '.discovery-cache/partitions.json')
await mkdir(resolve(ROOT, '.discovery-cache'), { recursive: true })
const checkpoint = await readFile(checkpointPath, 'utf8').then(JSON.parse).catch(() => ({}))
const partitions = []
const repositoriesByName = new Map()
let observed = 0
let observedPages = 0
async function captureRange(start, end, attempt = 1) {
  const query = rangeQuery(start, end)
  const cached = checkpoint[query]
  if (cached && Date.now() - Date.parse(cached.at) < 6 * 3600000) {
    partitions.push(query)
    observed += cached.items.length
    observedPages += Math.ceil(cached.items.length / 100)
    for (const repository of cached.items) repositoriesByName.set(repository.full_name.toLocaleLowerCase('en-US'), repository)
    process.stderr.write(`Resumed ${query} (${cached.items.length})\n`)
    return
  }
  const first = await search(query, 1)
  if (first.total_count > 1_000) {
    const midpoint = Math.floor((start + end) / 2_000) * 1_000
    if (midpoint < start || midpoint >= end) {
      throw new Error(`one-second partition exceeds the GitHub Search 1,000-result cap: ${query} (${first.total_count})`)
    }
    await captureRange(start, midpoint)
    await captureRange(midpoint + 1_000, end)
    return
  }
  const pages = Math.ceil(first.total_count / 100)
  const partitionRepositories = new Map()
  for (let page = 1; page <= pages; page += 1) {
    const value = page === 1 ? first : await search(query, page)
    for (const repository of value.items) {
      const key = repository.full_name.toLocaleLowerCase('en-US')
      const previous = partitionRepositories.get(key)
      if (!previous || String(repository.updated_at) > String(previous.updated_at)) partitionRepositories.set(key, repository)
    }
    process.stderr.write(`captured ${query} page ${page}/${pages}\n`)
  }
  if (partitionRepositories.size !== first.total_count) {
    if (attempt >= 4) {
      throw new Error(`unstable GitHub Search partition after ${attempt} attempts: ${query} (${partitionRepositories.size}/${first.total_count} unique)`)
    }
    process.stderr.write(`retrying unstable partition ${query}: ${partitionRepositories.size}/${first.total_count} unique on attempt ${attempt}\n`)
    await captureRange(start, end, attempt + 1)
    return
  }
  checkpoint[query] = { at: new Date().toISOString(), items: [...partitionRepositories.values()] }
  await writeFile(checkpointPath + '.tmp', JSON.stringify(checkpoint))
  await rename(checkpointPath + '.tmp', checkpointPath)
  partitions.push(query)
  observed += first.total_count
  observedPages += pages
  for (const [key, repository] of partitionRepositories) {
    const previous = repositoriesByName.get(key)
    if (!previous || String(repository.updated_at) > String(previous.updated_at)) repositoriesByName.set(key, repository)
  }
}
await captureRange(Date.UTC(2008, 0, 1), lastSecondBeforeNextUtcMidnight())
if (repositoriesByName.size !== observed) {
  throw new Error(`partitioned Topic snapshot mismatch: received ${repositoriesByName.size} unique repositories, expected ${observed}`)
}

const RETIRED_TOPIC = ['dsh', 'external'].join('-')
const publicTopics = (repository) => (repository.topics || []).filter((topic) => topic !== RETIRED_TOPIC)
const sanitizePublicText = (value = '') => String(value)
  .replaceAll(new RegExp(RETIRED_TOPIC, 'gi'), 'retired DSH ecosystem')
  .replaceAll(/\bNDA\b/gi, 'previous restricted program')
  .replaceAll('内测', '社区阶段')
const generatedAt = new Date().toISOString()
const discoveredRepositories = [...repositoriesByName.values()]
  .sort((left, right) => String(right.pushed_at || right.updated_at).localeCompare(String(left.pushed_at || left.updated_at)))
const repositories = discoveredRepositories.filter((repository) => !isRetiredRepositoryOwner(repository))
const snapshot = {
  schema: 'dsh-topic-discovery/v1',
  generatedAt,
  topic: TOPIC,
  source: 'https://github.com/search?q=topic%3Adsh-plugin&type=repositories',
  observedRepositoryCount: repositories.length,
  status: 'discovery-only',
  collection: {
    method: `${GITHUB_TOKEN ? 'authenticated' : 'anonymous'}-partitioned-github-search`,
    partitions,
    authenticated: Boolean(GITHUB_TOKEN),
    searchCapHandled: true,
    pluginCreationPolicy: {
      communityCreatedAtCutoff: COMMUNITY_PLUGIN_CREATED_AT_CUTOFF,
      officialOwnerExemptions: OFFICIAL_REPOSITORY_OWNERS,
    },
    retiredOwnerExclusionsApplied: true,
    excludedRepositoryCount: discoveredRepositories.length - repositories.length,
  },
  repositories: repositories.map((repository) => ({
    repositoryId: repository.id,
    owner: repository.owner.login,
    name: repository.name,
    url: repository.html_url,
    description: sanitizePublicText(repository.description || ''),
    language: repository.language,
    topics: publicTopics(repository),
    createdAt: repository.created_at,
    commitUpdatedAt: repository.pushed_at || repository.updated_at,
    metadataUpdatedAt: repository.updated_at,
    stars: repository.stargazers_count,
    archived: repository.archived,
    defaultBranch: repository.default_branch || 'main',
  })),
}

const discoveryPath = resolve(ROOT, 'public-discovery.json')
const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'))
discovery.generatedAt = generatedAt
discovery.topic.observedPages = observedPages
discovery.topic.observedRepositoryCount = repositories.length
discovery.topic.collection = snapshot.collection

await Promise.all([
  writeFile(resolve(ROOT, 'topic-repositories.json'), `${JSON.stringify(snapshot, null, 2)}\n`),
  writeFile(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`),
])
console.log(`refreshed public Topic snapshot: ${repositories.length} repositories across ${partitions.length} non-overlapping partitions (${discoveredRepositories.length - repositories.length} retired-owner sources excluded)`)
