#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { marketplaceAssets } from './marketplace-assets.mjs'

import { canonicalJson } from './build-install-feeds.mjs'
import { registryTrustPublicKey, verifyRegistryDocument } from './registry-signing-lib.mjs'

const origin = String(process.argv[2] || 'https://hub.omdsh.dev').replace(/\/$/, '')
const pinnedTrustRoots = JSON.parse(await readFile(resolve(import.meta.dirname, '../registry-trust-roots.json'), 'utf8'))
async function json(path) {
  const response = await fetch(`${origin}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response.json()
}

async function verifyLiveRelease() {
const [registry, trustRoots, distributions, plugins, marketplace] = await Promise.all([
  json('/registry-v1.json'),
  json('/registry-trust-roots.json'),
  json('/distributions-v1.json'),
  json('/api/v1/plugins.json'),
  json('/marketplace.json')
])
if (registry.schema !== 'omdsh-registry/v1' || registry.signature?.algorithm !== 'Ed25519' || !registry.signature?.keyId || !registry.signature?.value) {
  throw new Error('live Registry is not signed with an identified Ed25519 key')
}
if (canonicalJson(trustRoots) !== canonicalJson(pinnedTrustRoots)) {
  throw new Error('published Registry trust roots differ from the trust roots pinned in this release')
}
const trustedKey = registryTrustPublicKey(pinnedTrustRoots, registry.signature.keyId)
if (!verifyRegistryDocument(registry, { publicKey: trustedKey })) {
  throw new Error('live Registry Ed25519 signature does not verify against the published trust root')
}
if (distributions.registry?.snapshotId !== registry.snapshotId) throw new Error('live Distribution feed is bound to a different Registry')
if (plugins.schema !== 'omdsh-ai-plugins/v1') throw new Error('live plugin API schema mismatch')
console.log(`live Hub accepted: ${registry.entries.length} Registry entries, ${distributions.distributions.length} Distributions, ${plugins.count} plugin listings`)

const stagedMarketplace = JSON.parse(await readFile(resolve(import.meta.dirname, '../marketplace.json'), 'utf8'))
if (marketplace.schema !== 'dsh-hub-marketplace/v1' || canonicalJson(marketplace) !== canonicalJson(stagedMarketplace)) {
  throw new Error('live marketplace differs from the discovery and probes in this release')
}
const homeResponse = await fetch(origin, {signal: AbortSignal.timeout(15000)})
const home = await homeResponse.text()
if (!homeResponse.ok || !home.includes('assets/market.js') || !home.includes('assets/market.css')) {
  throw new Error('live home does not contain the new marketplace interface')
}
console.log(`live marketplace accepted: ${marketplace.totals.listed} projects; discovery ${marketplace.discoveryAt}; official DSH ${marketplace.official.version}`)

const compactAssets = marketplaceAssets(stagedMarketplace)
const publishedIndex = await json("/market-index.json")
if (canonicalJson(publishedIndex) !== canonicalJson(compactAssets.get("market-index.json"))) throw new Error("live compact index differs from this release")
const firstDetail = [...compactAssets.entries()].find(([path, value]) => path.startsWith("market-details/") && Object.keys(value.projects).length)
if (firstDetail && canonicalJson(await json(`/${firstDetail[0]}`)) !== canonicalJson(firstDetail[1])) throw new Error("live detail shard differs from this release")
console.log("live compact index and detail shard accepted")

}

// Asset routes can briefly reach different edge versions just after promotion.
// Retry the complete, exact verification; a mismatch never counts as success.
for (let attempt = 1; attempt <= 6; attempt++) {
  try {
    await verifyLiveRelease()
    break
  } catch (error) {
    if (attempt === 6) throw error
    console.error(`Live release is not fully observable yet (${attempt}/6): ${error.message}`)
    await delay(5000)
  }
}
