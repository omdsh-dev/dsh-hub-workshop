#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { registryTrustPublicKey } from './registry-signing-lib.mjs'
import { validateExternalEvidence } from './external-evidence-lib.mjs'
import { validateVerificationPriority } from './verification-priority-lib.mjs'
import { buildCatalogPresentation } from './catalog-presentation-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BUILD = resolve(ROOT, '.public-site')
const RETIRED_PRIVATE_OWNER = ['dsh', 'external'].join('-')
const json = async (path) => JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))

async function files(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) output.push(...await files(path))
    else if (entry.isFile()) output.push(path)
    else throw new Error(`public build contains a non-regular entry: ${path}`)
  }
  return output
}

const [catalog, registry, trustRoots, trustRootsSchema, recipes, ecosystem, workshop, runRecords, admissions, repositories, discovery, topicRepositories, topicAudit, baseline, intake, inventory, marketLayers, distributionSchema, profilePackSchema, profilePackEnvelopeSchema, distributionIntake, distributions, distributionIntakeSchema, distributionsSchema, externalEvidence, externalEvidenceSchema, verificationPriority, verificationPrioritySchema] = await Promise.all([
  json('catalog.json'),
  json('registry-v1.json'),
  json('registry-trust-roots.json'),
  json('registry-trust-roots.schema.json'),
  json('recipes-v1.json'),
  json('api/v1/ecosystem.json'),
  json('workshop-v1.json'),
  json('run-records.json'),
  json('registry-admissions.json'),
  json('ecosystem-repositories.json'),
  json('public-discovery.json'),
  json('topic-repositories.json'),
  json('topic-plugin-audit.json'),
  json('official-baseline.json'),
  json('intake-queue.json'),
  json('verification-inventory.json'),
  json('market-layers.json'),
  json('distribution.schema.json'),
  json('profile-pack.schema.json'),
  json('profile-pack-envelope.schema.json'),
  json('distribution-intake-queue.json'),
  json('distributions-v1.json'),
  json('distribution-intake.schema.json'),
  json('distributions-v1.schema.json'),
  json('external-evidence.json'),
  json('external-evidence.schema.json'),
  json('verification-priority.json'),
  json('verification-priority.schema.json'),
])

if (catalog.schema !== 'dsh-hub-index/v0.4') throw new Error('catalog schema mismatch')
const presentation = buildCatalogPresentation(catalog)
if (registry.schema !== 'omdsh-registry/v1') throw new Error('Registry schema mismatch')
if (trustRoots.schema !== 'omdsh-registry-trust-roots/v1'
  || trustRootsSchema.properties?.schema?.const !== 'omdsh-registry-trust-roots/v1'
  || trustRoots.keys.length === 0
  || trustRoots.keys.filter((entry) => entry.status === 'active').length !== 1
  || new Set(trustRoots.keys.map((entry) => entry.keyId)).size !== trustRoots.keys.length) {
  throw new Error('Registry trust roots must publish exactly one active, uniquely identified key')
}
for (const trustRoot of trustRoots.keys) registryTrustPublicKey(trustRoots, trustRoot.keyId, { requireActive: false })
if (recipes.schema !== 'omdsh-workshop-recipes/v1') throw new Error('Recipes schema mismatch')
if (ecosystem.schema !== 'omdsh-agent-ecosystem/v1') throw new Error('Ecosystem schema mismatch')
if (distributionSchema.properties?.schema?.const !== 'omdsh-distribution/v1'
  || distributionIntakeSchema.properties?.schema?.const !== 'omdsh-distribution-intake/v1'
  || distributionsSchema.properties?.schema?.const !== 'omdsh-distributions/v1'
  || !distributionSchema.required?.includes('agentPreset')
  || profilePackSchema.properties?.schema?.const !== 'omdsh-profile-pack/v1'
  || profilePackEnvelopeSchema.properties?.schema?.const !== 'omdsh-profile-pack-envelope/v1'
  || profilePackSchema.properties?.policy?.properties?.activation?.const !== 'candidate-and-confirm') {
  throw new Error('Distribution and Profile Pack schemas must preserve preset and candidate activation boundaries')
}
if (distributionIntake.schema !== 'omdsh-distribution-intake-queue/v1'
  || distributionIntake.registrySnapshotId !== registry.snapshotId
  || distributionIntake.records.some((record) => record.publication?.state === 'admitted')
  || distributions.schema !== 'omdsh-distributions/v1'
  || distributions.registry?.snapshotId !== registry.snapshotId
  || distributions.policy?.componentAuthority !== 'never-elevated-by-composition') {
  throw new Error('Distribution feeds must remain bound to one Registry snapshot without elevating component authority')
}
if (recipes.registry?.snapshotId !== registry.snapshotId
  || ecosystem.registry?.snapshotId !== registry.snapshotId
  || workshop.registry?.snapshotId !== registry.snapshotId) {
  throw new Error('public feeds do not share one Registry snapshot')
}
if (admissions.schema !== 'omdsh-registry-admissions/v1'
  || registry.entries.length !== admissions.admissions.length
  || registry.entries.length !== 0
  || workshop.projects.length !== 0
  || workshop.runRecords.length !== 0
  || runRecords.records.length !== 0
  || ecosystem.projects.length !== 0
  || recipes.recipes.length !== 0) {
  throw new Error('public install feeds must remain empty until a current-baseline admission passes every gate')
}
if (baseline.schema !== 'omdsh-official-baseline/v1'
  || baseline.runtime.version !== '0.1.0-rc.6'
  || baseline.runtime.releaseChannel !== 'release-candidate'
  || baseline.runtime.ga !== false
  || baseline.contracts.repositoryPlugin.status !== 'unavailable'
  || baseline.contracts.mcp.currentProtocolVersion !== '2026-07-28'
  || baseline.contracts.mcp.registrySchema !== 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json') {
  throw new Error('official baseline must reflect the public RC contract without claiming unavailable Repository Plugin support')
}
if (intake.schema !== 'omdsh-workshop-intake-queue/v1'
  || intake.officialBaseline !== `${baseline.runtime.package}@${baseline.runtime.version}`
  || intake.records.some((record) => record.registry?.state === 'admitted')) {
  throw new Error('public intake queue must match the official baseline and current empty Registry')
}
const intakeVerification = Object.fromEntries(['current-baseline-passed', 'source-evidence-passed', 'blocked'].map((state) => [
  state,
  intake.records.filter((record) => record.verification?.state === state).length,
]))
if (inventory.schema !== 'omdsh-workshop-verification-inventory/v1'
  || inventory.summary?.catalogProjects !== catalog.packages.length
  || inventory.projects?.length !== catalog.packages.length
  || (inventory.summary?.verification?.['current-baseline-passed'] ?? 0) !== intakeVerification['current-baseline-passed']
  || (inventory.summary?.verification?.['source-evidence-passed'] ?? 0) !== intakeVerification['source-evidence-passed']
  || (inventory.summary?.verification?.blocked ?? 0) !== intakeVerification.blocked
  || (inventory.summary?.verification?.untested ?? 0) !== catalog.packages.length
    - intakeVerification['current-baseline-passed'] - intakeVerification['source-evidence-passed'] - intakeVerification.blocked
  || inventory.summary?.registry?.admitted !== undefined
  || inventory.summary?.management?.transactional !== 2
  || inventory.summary?.management?.managed !== undefined
  || inventory.summary?.management?.guided !== catalog.packages.length - 2
  || inventory.projects.some((project) => !project.identity?.fullName || !Array.isArray(project.externalEvidence))
  || inventory.projects.some((project) => project.externalEvidence.some((evidence) => evidence.authority !== 'supplemental-only'))
  || inventory.projects.some((project) => !project.capabilities?.manifest || !project.capabilities?.install?.seamless || !project.capabilities?.install?.failureIsolation || !project.capabilities?.lifecycle?.hotReload || !project.capabilities?.integration || !project.capabilities?.admission)) {
  throw new Error('verification inventory must cover every Catalog project, match exact Intake evidence, and grant no Registry admission')
}
if (externalEvidenceSchema.properties?.schema?.const !== 'omdsh-supplemental-evidence/v1'
  || validateExternalEvidence(externalEvidence).length > 0
  || verificationPrioritySchema.properties?.schema?.const !== 'omdsh-verification-priority/v1'
  || validateVerificationPriority(verificationPriority).length > 0
  || verificationPriority.summary.catalogProjects !== catalog.packages.length
  || verificationPriority.queue.some((entry) => entry.authority !== 'none-until-admission')) {
  throw new Error('external observations and verification priority must remain supplemental and non-authoritative')
}
if (topicAudit.schema !== 'omdsh-topic-plugin-audit/v3'
  || topicAudit.stats?.repositories !== topicRepositories.observedRepositoryCount
  || topicAudit.repositories.length !== topicRepositories.observedRepositoryCount
  || Object.values(topicAudit.stats?.decisions || {}).reduce((total, count) => total + count, 0) !== topicAudit.stats.repositories) {
  throw new Error('Topic plugin audit must classify every observed repository exactly once')
}
const qualifiedRepositories = new Set(topicAudit.repositories
  .filter((entry) => entry.decision === 'include'
    && ['verified', 'static-evidence-passed'].includes(entry.qualification)
    && (entry.evidence?.strongSignals || []).length > 0)
  .map((entry) => `${entry.owner}/${entry.name}`.toLocaleLowerCase('en-US')))
const catalogRepositories = new Set(catalog.packages.map((entry) => new URL(entry.repository).pathname.split('/').filter(Boolean).slice(0, 2).join('/').toLocaleLowerCase('en-US')))
if (catalog.packages.length !== catalog.stats?.packages
  || presentation.listings.length !== catalog.stats?.listings
  || catalog.stats?.repositories !== catalogRepositories.size
  || catalog.stats?.observedTopicRepositories !== topicRepositories.observedRepositoryCount
  || catalog.stats?.qualifiedRepositories !== topicAudit.stats.decisions.include
  || catalog.stats?.pendingRepositories !== (topicAudit.stats.decisions.review || 0)
  || catalog.stats?.marketRepositories !== topicAudit.stats.decisions.market
  || catalog.stats?.excludedRepositories !== topicAudit.stats.decisions.exclude
  || catalog.stats?.reviewed !== 11
  || new Set(catalog.packages.map((entry) => entry.id)).size !== catalog.packages.length
  || catalogRepositories.size !== qualifiedRepositories.size
  || [...catalogRepositories].some((repository) => !qualifiedRepositories.has(repository))
  || catalog.packages.some((entry) => entry.status === 'discovery'
    && !/^(?:verified|static)-/.test(entry.discovery?.qualification || ''))) {
  throw new Error('public catalog must contain only qualified plugin entries and eleven reviewed candidates')
}
const [pluginApi, pluginTypes, marketApi] = await Promise.all([json('api/v1/plugins.json'), json('api/v1/plugin-types.json'), json('api/v1/market.json')])
if (pluginApi.schema !== 'omdsh-ai-plugins/v1'
  || pluginApi.count !== presentation.listings.length
  || pluginApi.componentCount !== catalog.packages.length
  || pluginApi.projects.length !== presentation.listings.length
  || pluginApi.projects.some((project) => project.registry?.state !== 'ineligible')
  || pluginApi.projects.some((project) => !project.identity?.fullName || !Array.isArray(project.externalEvidence))
  || pluginApi.projects.some((project) => !project.capabilities?.install?.seamless)
  || pluginTypes.schema !== 'omdsh-ai-plugin-types/v1'
  || pluginTypes.totals?.catalogProjects !== presentation.listings.length
  || pluginTypes.totals?.catalogComponents !== catalog.packages.length
  || pluginTypes.management.find((entry) => entry.id === 'transactional')?.count !== 2
  || (pluginTypes.management.find((entry) => entry.id === 'managed')?.count ?? 0) !== 0
  || pluginTypes.management.find((entry) => entry.id === 'guided')?.count !== catalog.packages.length - 2) {
  throw new Error('plugin API must project the full Catalog and verification inventory without install authority')
}
const nonPluginIds = new Set(marketLayers.projects.map((project) => project.id))
const pluginIds = new Set(catalog.packages.map((project) => project.id))
if (marketLayers.schema !== 'omdsh-market-layers/v2'
  || marketLayers.totals?.projects !== marketLayers.projects.length
  || marketLayers.totals?.infrastructure !== marketLayers.projects.filter((project) => project.layer === 'infrastructure').length
  || marketLayers.totals?.distribution !== marketLayers.projects.filter((project) => project.layer === 'distribution').length
  || marketLayers.projects.length !== marketLayers.totals.projects
  || marketLayers.projects.some((project) => project.review?.state === 'curated' && !/^[0-9a-f]{40}$/.test(project.source?.ref || ''))
  || marketLayers.projects.some((project) => project.review?.state === 'pending-review' && project.verification?.state !== 'unverified')
  || marketLayers.projects.some((project) => project.registry?.state !== 'ineligible' || project.registry?.reason !== 'market-layer-not-plugin-install')
  || marketLayers.projects.some((project) => pluginIds.has(project.id))) {
  throw new Error('non-plugin market layers must preserve review facts, stay disjoint from the plugin Catalog, and remain ineligible for installation')
}
if (marketApi.schema !== 'omdsh-ai-market/v1'
  || marketApi.totals?.projects !== presentation.listings.length + marketLayers.projects.length
  || marketApi.totals?.plugin !== presentation.listings.length
  || marketApi.totals?.infrastructure !== marketLayers.totals.infrastructure
  || marketApi.totals?.distribution !== marketLayers.totals.distribution
  || marketApi.totals?.installable !== 0
  || marketApi.projects.length !== marketApi.totals.projects
  || marketApi.projects.filter((project) => project.layer !== 'plugin').some((project) => !nonPluginIds.has(project.id))) {
  throw new Error('market API must combine plugin and non-plugin layers without granting installation authority')
}
for (const protectedId of nonPluginIds) {
  if (pluginIds.has(protectedId)
    || inventory.projects.some((project) => project.id === protectedId)
    || pluginApi.projects.some((project) => project.id === protectedId)
    || registry.entries.some((project) => project.id === protectedId)) {
    throw new Error(`non-plugin market project leaked into a plugin authority: ${protectedId}`)
  }
}
if (repositories.schema !== 'omdsh-public-repositories/v1' || repositories.repositories.length !== 10) {
  throw new Error('public repository map must contain the ten approved repositories')
}
if (discovery.schema !== 'omdsh-public-discovery/v1') throw new Error('public discovery schema mismatch')
if (discovery.organization?.owner !== 'omdsh-dev'
  || discovery.organization?.observedRepositoryCount !== 63
  || discovery.organization?.projectCount !== 62
  || discovery.organization?.repositories?.length !== 63) {
  throw new Error('public organization discovery snapshot must contain 63 repositories and 62 projects')
}
if (discovery.topic?.name !== 'dsh-plugin'
  || discovery.topic?.observedRepositoryCount !== topicRepositories.observedRepositoryCount
  || discovery.topic?.status !== 'discovery-only') {
  throw new Error('dsh-plugin Topic discovery summary must match the complete snapshot')
}
if (topicRepositories.schema !== 'dsh-topic-discovery/v1'
  || topicRepositories.topic !== 'dsh-plugin'
  || topicRepositories.observedRepositoryCount !== topicRepositories.repositories.length
  || topicRepositories.status !== 'discovery-only') {
  throw new Error('Topic repository snapshot must contain every observed public discovery repository')
}

const builtFiles = await files(BUILD)
if (builtFiles.length !== 71) throw new Error(`public build must contain exactly 71 files, received ${builtFiles.length}`)
for (const repository of repositories.repositories) {
  if (!/^https:\/\/github[.]com\/omdsh-dev\/[A-Za-z0-9._-]+$/.test(repository.url)) {
    throw new Error(`unapproved public repository URL: ${repository.url}`)
  }
}
for (const repository of discovery.organization.repositories) {
  if (!/^https:\/\/github[.]com\/omdsh-dev\/[A-Za-z0-9._-]+$/.test(repository.url)) {
    throw new Error(`unapproved discovery repository URL: ${repository.url}`)
  }
}
for (const repository of topicRepositories.repositories) {
  if (!/^https:\/\/github[.]com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9._-]+$/.test(repository.url)) {
    throw new Error(`invalid Topic discovery repository URL: ${repository.url}`)
  }
}
for (const repository of topicAudit.repositories) {
  if (!/^https:\/\/github[.]com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9._-]+$/.test(repository.url)) {
    throw new Error(`invalid Topic plugin audit repository URL: ${repository.url}`)
  }
}
for (const entry of catalog.packages) {
  if (!/^https:\/\/github[.]com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9._-]+$/.test(entry.repository)) {
    throw new Error(`invalid catalog repository URL: ${entry.repository}`)
  }
}

const publicTextExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.yaml', '.yml'])
const contents = (await Promise.all(builtFiles
  .filter((path) => publicTextExtensions.has(path.slice(path.lastIndexOf('.'))))
  .map((path) => readFile(path, 'utf8')))).join('\n')
const forbiddenPublicContent = new RegExp(`${RETIRED_PRIVATE_OWNER}|Private Preview|/auth/github|github_pat_|\\bgh[opusr]_|\\bnpm_[A-Za-z0-9]{20,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----`, 'i')
if (forbiddenPublicContent.test(contents)) {
  throw new Error('public site contains private-source, login, credential, or key material')
}

const [home, app, styles, projectsPage, discoveryApp, configurations, developers, publish, contributing, agentPromptZh, agentPromptEn] = await Promise.all([
  readFile(resolve(ROOT, 'index.html'), 'utf8'),
  readFile(resolve(ROOT, 'assets/app.js'), 'utf8'),
  readFile(resolve(ROOT, 'assets/styles.css'), 'utf8'),
  readFile(resolve(ROOT, 'projects.html'), 'utf8'),
  readFile(resolve(ROOT, 'assets/discovery.js'), 'utf8'),
  readFile(resolve(ROOT, 'configurations.html'), 'utf8'),
  readFile(resolve(ROOT, 'developer-guide.html'), 'utf8'),
  readFile(resolve(ROOT, 'publish.html'), 'utf8'),
  readFile(resolve(ROOT, 'contributing.html'), 'utf8'),
  readFile(resolve(ROOT, 'agent-submission-prompt.zh.md'), 'utf8'),
  readFile(resolve(ROOT, 'agent-submission-prompt.en.md'), 'utf8'),
])
for (const required of ['discover-stage', 'featured-tabs', 'advanced-filter', 'active-filter-count', 'data-ecosystem-count', 'data-catalog-view="grid"', 'data-catalog-view="list"', 'catalog-pagination']) {
  if (!home.includes(required)) throw new Error(`restored Workshop layout is missing ${required}`)
}
for (const required of ['ecosystem-project-list', 'data-ecosystem-layer="infrastructure"', 'data-ecosystem-layer="distribution"']) {
  if (!projectsPage.includes(required)) throw new Error(`project directory is missing ${required}`)
}
if (!discoveryApp.includes("fetch('market-layers.json')") || !discoveryApp.includes('renderEcosystem')) {
  throw new Error('ecosystem infrastructure and distributions must render on the project subpage')
}
if (!home.includes('class="github-star"') || !home.includes('https://github.com/omdsh-dev/dsh-hub-workshop')) {
  throw new Error('the primary navigation must expose the public Workshop GitHub Star link')
}
if (!app.includes('featured.empty.recoverable') || !app.includes('visiblePackages') || !app.includes('project-capability-matrix')) {
  throw new Error('restored Workshop interactions must preserve empty recoverable state and catalog pagination')
}
if (!home.includes('data-featured-mode="stars"')
  || !app.includes('projectStars')
  || !app.includes('commitUpdatedAt')
  || !app.includes("t('project.created')")) {
  throw new Error('featured lanes must use GitHub stars and repository commit activity')
}
if (!app.includes('selectSpotlightPackages')
  || !app.includes("pkg.discovery?.qualification === 'verified-plugin-contract'")
  || !app.includes('spotlight-project-stars')) {
  throw new Error('homepage spotlight must rank file-verified plugin contracts by GitHub stars')
}
if (!publish.includes('copy-agent-submission-prompt')
  || !publish.includes('agent-submission-prompt.zh.md')
  || !developers.includes('agent-submission-prompt.en.md')
  || !publish.includes('copy-distribution-cli')
  || !publish.includes('omdsh pack build')) {
  throw new Error('Author Studio and developer guide must expose Agent submission instructions')
}
for (const prompt of [agentPromptZh, agentPromptEn]) {
  if (!prompt.includes('omdsh-workshop-submission/v2')
    || !prompt.includes('package.json#dshWorkshop')
    || !prompt.includes('omdsh-dev/dsh-hub-workshop')
    || !prompt.includes('scripts/intake.mjs validate')
    || !prompt.includes('pending-review')
    || !prompt.includes('40')) {
    throw new Error('Agent submission instruction is missing an immutable-source, validation, or review boundary')
  }
}
for (const [name, source, minimumLines, required] of [
  ['configurations', configurations, 150, 'configuration-task-finder'],
  ['developer guide', developers, 700, 'ai-integration-prompt'],
  ['publish', publish, 250, 'manifest-form'],
  ['contributing', contributing, 330, 'omdsh-workshop-submission/v2'],
]) {
  if (source.split('\n').length < minimumLines || !source.includes(required)) {
    throw new Error(`${name} page regressed to an incomplete public placeholder`)
  }
}
if (!/\.author-project-mark\s*\{[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/s.test(styles)) {
  throw new Error('author project artwork must remain clipped to its icon container')
}

console.log(`public site accepted: ${catalog.packages.length} catalog entries (${catalog.stats.reviewed} reviewed), ${discovery.organization.projectCount} organization projects, ${discovery.topic.observedRepositoryCount} Topic repositories, ${registry.entries.length} install entry, snapshot ${registry.snapshotId}`)
