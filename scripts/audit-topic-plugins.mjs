#!/usr/bin/env node
import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder("ipv4first");

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  capabilityProfile,
  validateOfficialMcpManifest,
  validateWorkshopManifest,
} from './workshop-manifest-lib.mjs'
import {
  COMMUNITY_PLUGIN_CREATED_AT_CUTOFF,
  OFFICIAL_REPOSITORY_OWNERS,
  packageDependencyEvidence,
  repositoryCreationPolicy,
} from './topic-admission-policy.mjs'
import { repositoryFingerprint } from './topic-delta-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const snapshotPath = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, 'topic-repositories.json')
const outputPath = process.argv[3] ? resolve(process.argv[3]) : resolve(ROOT, 'topic-plugin-audit.json')
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
const previousReport = await readFile(outputPath, 'utf8').then(JSON.parse).catch(() => null)
const previousGeneratedAt = previousReport?.schema === 'omdsh-topic-plugin-audit/v3'
  && Number.isFinite(Date.parse(previousReport.generatedAt))
  ? previousReport.generatedAt
  : null
const previousByRepository = new Map((previousReport?.repositories || [])
  .map((repository) => [`${repository.owner}/${repository.name}`.toLocaleLowerCase('en-US'), repository]))
const currentCatalog = await readFile(resolve(ROOT, 'catalog.json'), 'utf8').then(JSON.parse).catch(() => ({ packages: [] }))
const currentCatalogByRepository = new Map()
for (const project of currentCatalog.packages || []) {
  try {
    const key = new URL(project.repository).pathname.split('/').filter(Boolean).slice(0, 2).join('/').toLocaleLowerCase('en-US')
    const projects = currentCatalogByRepository.get(key) || []
    projects.push(project)
    currentCatalogByRepository.set(key, projects)
  } catch {}
}
const currentCatalogRepositories = new Set(currentCatalogByRepository.keys())
const USER_AGENT = 'omdsh-workshop-topic-audit/3.0'
const ENGINE_VERSION = '5.0.0'
const decoder = new TextDecoder()
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.OMDSH_TOPIC_FETCH_TIMEOUT_MS || '5000', 10)
const AUDIT_CONCURRENCY = Number.parseInt(process.env.OMDSH_TOPIC_AUDIT_CONCURRENCY || '48', 10)
if (!Number.isInteger(FETCH_TIMEOUT_MS) || FETCH_TIMEOUT_MS < 1_000 || FETCH_TIMEOUT_MS > 60_000) throw new Error('invalid OMDSH_TOPIC_FETCH_TIMEOUT_MS')
if (!Number.isInteger(AUDIT_CONCURRENCY) || AUDIT_CONCURRENCY < 1 || AUDIT_CONCURRENCY > 128) throw new Error('invalid OMDSH_TOPIC_AUDIT_CONCURRENCY')

function result(decision, reasonCode, reason, { qualification = null, marketLayer = null, evidence = {} } = {}) {
  return { decision, reasonCode, reason, qualification, marketLayer, evidence }
}

const include = (reasonCode, reason, evidence) => result('include', reasonCode, reason, { qualification: 'verified', evidence })
const review = (reasonCode, reason, evidence = {}) => result('review', reasonCode, reason, { qualification: 'pending-review', evidence })
const market = (marketLayer, reasonCode, reason, evidence = {}) => result('market', reasonCode, reason, { qualification: 'pending-review', marketLayer, evidence })
const exclude = (reasonCode, reason, evidence = {}) => result('exclude', reasonCode, reason, { evidence })

const MANUAL_DECISIONS = new Map([
  ['deepseek-ai/deepseek-harness', exclude('core-product', 'DeepSeek Harness 主仓不是生态插件。')],
  ['omdsh-dev/7d7d', include('verified-curated-fixed-source', '已存在独立固定 commit 与人工信任审查记录；自动依赖扫描不替代该记录。', {
    verificationLevel: 'curated-fixed-source',
    strongSignals: ['fixed public commit', 'reviewed profile bundle patch and runtime assets'],
    pluginClaims: ['profile-bundle'],
    curatedReview: {
      inspectedCommit: '1c8ea4981fcfdb58e8f9726058b950aaf8cc9404',
      state: 'needs-fix',
      rc6Verified: false,
    },
  })],
  ['omdsh-dev/session-teleport', include('verified-curated-fixed-source', '已存在独立固定 commit 与人工信任审查记录；自动依赖扫描不替代该记录。', {
    verificationLevel: 'curated-fixed-source',
    strongSignals: ['fixed public commit', 'reviewed profile adapter and lifecycle evidence'],
    pluginClaims: ['profile-bundle'],
    curatedReview: {
      inspectedCommit: '0640ca9ccd1b9ac12709b74aecf2a0e75c8bb4b1',
      state: 'needs-fix',
      rc6Verified: false,
    },
  })],
  ['omdsh-dev/dsh-hub-workshop', market('infrastructure', 'ecosystem-infrastructure', 'Workshop/Catalog 权威仓属于生态基础设施。')],
  ['omdsh-dev/dsh-hub', market('infrastructure', 'ecosystem-infrastructure', 'Hub 消费端属于生态基础设施。')],
  ['omdsh-dev/omdsh-runtime', market('infrastructure', 'ecosystem-infrastructure', 'OMDSH Runtime 属于生态基础设施。')],
  ['omdsh-dev/dsh-mygo', market('infrastructure', 'ecosystem-infrastructure', '插件管理与治理框架属于生态基础设施。', {
    manualReview: {
      inspectedCommit: '4566748646823f8e2123f6addcf22b55e305e740',
      verificationLevel: 'static-public-source',
      findings: [
        'root-package-manifest-absent',
        'multi-package-plugin-management-framework',
        'subpackages-target-older-rc-line',
        'workspace-dependencies-unresolved',
        'public-packages-unavailable',
        'current-public-baseline-not-verified',
      ],
    },
  })],
  ['omdsh-dev/omdsh', market('distribution', 'community-distribution', 'Oh My DSH 是社区发行版。')],
  ['omdsh-dev/plugin-template', exclude('template-or-guide', '插件模板不作为作品条目收录。')],
  ['omdsh-dev/dsh-plugin-dev', exclude('template-or-guide', '插件开发文档与说明不是最终用户插件。')],
  ['omdsh-dev/dsh-plugin-skills', market('infrastructure', 'ecosystem-infrastructure', '插件开发与测试 Agent Skills 属于生态工具。')],
  ['omdsh-dev/dsh-tool-browser', market('infrastructure', 'ecosystem-infrastructure', '浏览器接入配置与指南属于生态接入工具。')],
  ['omdsh-dev/dsh-github-integration', include('verified-direct-skill', '固定提交中的直接 Skill 契约等待当前基线静态审核。', {
    verificationLevel: 'curated-fixed-source',
    strongSignals: ['package.json#dshWorkshop', 'direct static workflow skill'],
    pluginClaims: ['skill'],
  })],
  ['omdsh-dev/toybox', include('verified-plugin-collection', '仓库中的八个叶子插件已分别建立公开条目。', {
    verificationLevel: 'curated-fixed-source',
    strongSignals: ['eight package.json#dshWorkshop leaf declarations'],
    pluginClaims: ['mcp-server', 'skill'],
    collectionSignals: ['plugins/ tree (8 children)'],
  })],
])

const AWESOME_RE = /(?:^|[-_.])(awesome|handbook|wiki)(?:[-_.]|$)|\b(?:awesome list|curated list|resource list|handbook|wiki|guide to|from scratch)\b|(?:教程|指南|手册|百科|资源列表|项目列表|插件列表|生态列表|导航站)/i
const TEMPLATE_RE = /(?:^|[-_.])(?:template|starter|boilerplate|scaffold|example)(?:[-_.]|$)|\b(?:template|starter|boilerplate|scaffold|placeholder|group photo|leaderboard)\b|(?:模板|脚手架|占位|排行榜|合影)/i
const DIRECTORY_RE = /(?:plugin|extension)[-_ ]?(?:store|market(?:place)?|index|directory|registry|hub|radar|landscape|recommend)|(?:find|search)[-_ ]?(?:plugin|extension)|(?:插件|扩展)(?:商店|市场|目录|索引|导航|排行|推荐)/i
const INFRASTRUCTURE_RE = /(?:^|[-_.])(?:desktop|launcher|client|tui|vscode|devkit|doctor|installer|publisher|manager|updater)(?:[-_.\s]|$)|\b(?:desktop app|desktop wrapper|desktop shell|terminal (?:ui|client)|launcher|plugin manager|plugin marketplace|plugin store|developer toolkit|companion cli|vs ?code (?:client|extension)|packager)\b|(?:桌面端|桌面版|桌面客户端|桌面壳|启动器|终端 ?UI|插件管理器|插件市场|插件商店|开发工具|诊断工具)/i
const DISTRIBUTION_RE = /(?:^|[-_.])(?:oh[-_.]?my[-_.]?dsh|modpack|plugin[-_.]?pack)(?:[-_.\s]|$)|\b(?:plugin collection|plugins collection|plugin suite|community distribution|plugin kit|plugin pack|modpack|packager|curated bundle)\b|(?:插件合集|插件集合|插件精选集|插件聚合|社区发行版|整合包)/i
const PLUGIN_WORD_RE = /\b(?:plugins?|extensions?|providers?|bundles?|skins?|skills?|adapters?|bridges?|channels?|tools?)\b|(?:插件|扩展|提供方|皮肤|技能|适配器|桥接|工具)/i
const DSH_RE = /\b(?:deepseek[ -]?harness|dsh)\b/i

const repositoryKey = (repository) => `${repository.owner}/${repository.name}`.toLocaleLowerCase('en-US')
const productText = (repository) => `${repository.name}\n${repository.description || ''}`
const encodePath = (value) => value.split('/').map(encodeURIComponent).join('/')

async function fetchText(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) return null
    const buffer = await response.arrayBuffer()
    return decoder.decode(buffer.byteLength > 1_500_000 ? buffer.slice(0, 1_500_000) : buffer)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function rawUrl(repository, path) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/${encodePath(repository.defaultBranch || 'main')}/${encodePath(path)}`
}

function treeUrl(repository, path = '') {
  const base = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
  return path ? `${base}/tree/${encodePath(repository.defaultBranch || 'main')}/${encodePath(path)}` : base
}

function pathsFromHtml(source) {
  if (!source) return []
  return [...new Set([...source.matchAll(/"path":"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`))
    .filter((path) => path && path !== '/'))]
}

function parseJson(source) {
  if (!source) return null
  try { return JSON.parse(source) } catch { return null }
}

function nestedStrings(value) {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(nestedStrings)
}

function safeRepositoryPath(value) {
  const path = String(value || '').replace(/^\.\//, '')
  return path && !path.startsWith('/') && !path.split('/').includes('..') ? path : null
}

function runtimePaths(pkg, manifest) {
  const values = [
    pkg?.main,
    pkg?.module,
    pkg?.browser,
    ...nestedStrings(pkg?.exports),
    ...nestedStrings(pkg?.bin),
    manifest?.main,
    manifest?.entry,
    manifest?.runtime,
    manifest?.server,
    ...nestedStrings(manifest?.bin),
  ]
  return [...new Set(values
    .map(safeRepositoryPath)
    .filter((path) => path && /\.(?:[cm]?js|tsx?|jsx)$/i.test(path) && !/\.d\.ts$/i.test(path)))]
    .slice(0, 12)
}

function pluginClaims(text) {
  const matches = []
  for (const [label, pattern] of [
    ['explicit-harness-plugin', /\b(?:(?:deepseek harness|dsh)\s+(?:native\s+)?(?:plugins?|extensions?|providers?)|(?:plugins?|extensions?|providers?)\s+(?:for|to)\s+(?:deepseek harness|dsh))\b/i],
    ['profile-install', /\bdsh\s+plugin\s+(?:add|install|remove)|--profile\b/i],
    ['repository-plugin', /repository[- ]plugin|\.dsh-plugin\b/i],
    ['profile-bundle', /profile[- ]bundle|cordis\.patch\.ya?ml|"bundle"\s*:/i],
  ]) if (pattern.test(text)) matches.push(label)
  return matches
}

async function mapLimit(items, limit, callback) {
  const output = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await callback(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return output
}

function obviousClassification(repository) {
  const key = repositoryKey(repository)
  const manual = MANUAL_DECISIONS.get(key)
  if (manual) return manual
  const text = productText(repository)
  const lowerName = repository.name.toLocaleLowerCase('en-US')
  const hasDshClaim = DSH_RE.test(text) || /(?:^|[-_.])dsh(?:[-_.]|$)|deepseek[-_.]?harness/i.test(lowerName)

  if (repository.archived) return exclude('archived', '仓库已归档，不进入当前插件目录。')
  if (/(?:^|[-_.])(?:awesome|handbook|wiki)(?:[-_.]|$)/i.test(lowerName)) {
    return exclude('awesome-or-documentation', 'Awesome、手册、Wiki 或纯导航文档不是插件作品。')
  }
  if (/(?:^|[-_.])(?:template|starter|boilerplate|scaffold|example)(?:[-_.]|$)/i.test(lowerName)) {
    return exclude('template-or-placeholder', '模板、脚手架、示例、排行榜或占位项目不是插件作品。')
  }
  if (AWESOME_RE.test(text)) return exclude('awesome-or-documentation', 'Awesome、手册、Wiki 或纯导航文档不是插件作品。')
  if (TEMPLATE_RE.test(text)) return exclude('template-or-placeholder', '模板、脚手架、示例、排行榜或占位项目不是插件作品。')
  return null
}

function marketLayerHint(repository) {
  const text = productText(repository)
  const lowerName = repository.name.toLocaleLowerCase('en-US')
  const hasDshClaim = DSH_RE.test(text) || /(?:^|[-_.])dsh(?:[-_.]|$)|deepseek[-_.]?harness/i.test(lowerName)
  if (!hasDshClaim) return null
  if (DISTRIBUTION_RE.test(text)) return 'distribution'
  if (DIRECTORY_RE.test(text) || INFRASTRUCTURE_RE.test(text)) return 'infrastructure'
  return null
}

async function inspect(repository) {
  const obvious = obviousClassification(repository)
  const marketHint = marketLayerHint(repository)
  const creation = repositoryCreationPolicy(repository)
  if (obvious && obvious.decision !== 'include') return obvious
  if (!creation.eligible) {
    return exclude(creation.reason, creation.createdAt
      ? `社区插件仓库创建于 ${COMMUNITY_PLUGIN_CREATED_AT_CUTOFF} 之前，只保留审计记录。`
      : '无法读取社区仓库的 GitHub 创建时间，按失败关闭策略不进入插件目录。')
  }
  if (obvious) return obvious

  // GitHub HTML tree pages are presentation surfaces, not protocol evidence,
  // and become the dominant timeout when a Topic has thousands of entries.
  // Read raw, deterministic contract paths directly. Unknown collections stay
  // in review unless a curated decision expands their leaf components.
  const rootPaths = []
  // README claims are never sufficient for inclusion. Probe only files that
  // can form protocol, package, dependency, or executable-artifact evidence;
  // this avoids six guaranteed README 404s for thousands of Topic-only repos.
  const requested = [
    'package.json',
    'dsh.plugin.json',
    'cordis.patch.yml',
    'cordis.patch.yaml',
    '.dsh-plugin/package.json',
    '.dsh-plugin/manifest.json',
    '.dsh-plugin/prepare.js',
    'SKILL.md',
    'mcp.json',
    '.mcp.json',
    'server.json',
  ]
  const files = await Promise.all(requested.map(async (path) => [path, await fetchText(rawUrl(repository, path))]))
  const contents = Object.fromEntries(files.filter(([, source]) => source !== null))
  const pkg = parseJson(contents['package.json'])
  const dshManifest = parseJson(contents['dsh.plugin.json'])
  const repositoryPluginManifest = parseJson(contents['.dsh-plugin/package.json'])
  const mcpManifest = parseJson(contents['mcp.json'] || contents['.mcp.json'])
  const officialMcpManifest = parseJson(contents['server.json'])
  const workshopManifest = pkg?.dshWorkshop
  const combinedText = productText(repository)
  const lowerName = repository.name.toLocaleLowerCase('en-US')
  const hasDshClaim = DSH_RE.test(combinedText) || /(?:^|[-_.])dsh(?:[-_.]|$)|deepseek[-_.]?harness/i.test(lowerName)
  const hasPluginClaim = PLUGIN_WORD_RE.test(combinedText)
  const claims = pluginClaims(combinedText)
  const declaredDependencyCheck = packageDependencyEvidence(pkg)
  const deepseekDependencies = Object.keys(declaredDependencyCheck.production)
  const packageDsh = pkg?.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : null
  const bundlePatch = packageDsh?.bundle?.patch || null
  const bundlePatchPath = safeRepositoryPath(bundlePatch)
  const bundlePatchSource = bundlePatchPath
    ? (contents[bundlePatchPath] ?? await fetchText(rawUrl(repository, bundlePatchPath)))
    : null
  const entryPaths = runtimePaths(pkg, dshManifest || repositoryPluginManifest || mcpManifest)
  const entryFiles = Object.fromEntries((await Promise.all(entryPaths
    .map(async (path) => [path, await fetchText(rawUrl(repository, path))])))
    .filter(([, source]) => source !== null && source.trim().length >= 40))
  const resolvedRuntimePaths = Object.keys(entryFiles)
  const dependencyIntegrationText = [
    bundlePatchSource || '',
    ...Object.values(entryFiles),
    JSON.stringify(packageDsh || {}),
    JSON.stringify(dshManifest || {}),
    JSON.stringify(workshopManifest || {}),
  ].join('\n')
  const referencedProduction = Object.keys(declaredDependencyCheck.versionedProduction)
    .filter((dependency) => dependencyIntegrationText.includes(dependency))
  const dependencyCheck = {
    ...declaredDependencyCheck,
    referencedProduction,
    linkedFromRuntimeOrManifest: referencedProduction.length > 0,
  }
  const pluginDirPaths = []
  const pluginChildren = []
  const packageChildren = []
  const declaredSignals = []
  const strongSignals = []
  const validPatch = typeof bundlePatchSource === 'string'
    && bundlePatchSource.length >= 20
    && /(?:^|\n)\s*-?\s*(?:insert|remove|replace|patch|merge):/m.test(bundlePatchSource)
  const validRepositoryPlugin = repositoryPluginManifest !== null
    && (Boolean(contents['.dsh-plugin/prepare.js'])
      || Boolean(contents['.dsh-plugin/manifest.json'])
      || pluginDirPaths.some((path) => /(?:manifest|plugin|prepare|install|config).*(?:json|ya?ml|js|mjs|ts)$/i.test(path)))
  const validDshManifest = dshManifest !== null && resolvedRuntimePaths.length > 0
  const validSkill = typeof contents['SKILL.md'] === 'string' && contents['SKILL.md'].trim().length >= 120
  const validMcp = mcpManifest !== null && (resolvedRuntimePaths.length > 0 || JSON.stringify(mcpManifest).length >= 80)
  const workshopPaths = workshopManifest && typeof workshopManifest === 'object'
    ? [workshopManifest.integration?.artifact, ...Object.values(workshopManifest.evidence || {})]
      .map(safeRepositoryPath).filter(Boolean)
    : []
  const workshopFiles = Object.fromEntries((await Promise.all([...new Set(workshopPaths)]
    .map(async (path) => [path, contents[path] ?? await fetchText(rawUrl(repository, path))])))
    .filter(([, source]) => typeof source === 'string' && source.trim().length > 0))
  const workshopErrors = workshopManifest === undefined ? [] : validateWorkshopManifest(workshopManifest)
  if (workshopManifest?.integration?.protocol === 'mcp') {
    const serverPath = workshopManifest.integration.mcp?.serverManifest
    const serverManifest = parseJson(workshopFiles[serverPath]) || (serverPath === 'server.json' ? officialMcpManifest : null)
    workshopErrors.push(...validateOfficialMcpManifest({ packageJson: pkg, serverManifest, declaration: workshopManifest }))
  }
  const workshopEvidencePaths = workshopManifest && typeof workshopManifest === 'object'
    ? Object.values(workshopManifest.evidence || {}).filter((path) => typeof path === 'string')
    : []
  const missingWorkshopEvidence = workshopEvidencePaths.filter((path) => !workshopFiles[path])
  if (missingWorkshopEvidence.length) workshopErrors.push(`declared evidence files are missing: ${missingWorkshopEvidence.join(', ')}`)
  const workshopProtocol = workshopManifest?.integration?.protocol
  const validWorkshopArtifact = workshopErrors.length === 0 && ({
    'harness-profile': validPatch && dependencyCheck.linkedFromRuntimeOrManifest,
    'harness-repository': validRepositoryPlugin,
    'harness-cordis': resolvedRuntimePaths.length > 0 && dependencyCheck.linkedFromRuntimeOrManifest,
    mcp: Boolean(parseJson(workshopFiles[workshopManifest?.integration?.artifact]) || officialMcpManifest),
    skill: validSkill,
    'third-party': resolvedRuntimePaths.length > 0 && hasDshClaim && dependencyCheck.linkedFromRuntimeOrManifest,
  }[workshopProtocol] === true)
  if (bundlePatch) declaredSignals.push(`package.json:dsh.bundle.patch=${bundlePatch}`)
  if (contents['dsh.plugin.json']) declaredSignals.push('dsh.plugin.json')
  if (packageDsh && Object.keys(packageDsh).length) declaredSignals.push('package.json:dsh metadata')
  if (deepseekDependencies.length) declaredSignals.push(`DeepSeek Harness dependencies (${deepseekDependencies.length})`)
  if (validPatch) strongSignals.push(`resolved bundle patch:${bundlePatchPath}`)
  if (validRepositoryPlugin) strongSignals.push('resolved .dsh-plugin package and runtime asset')
  if (validDshManifest) strongSignals.push('resolved dsh.plugin.json runtime entry')
  if (resolvedRuntimePaths.length) strongSignals.push(`resolved runtime artifact (${resolvedRuntimePaths.length})`)
  if (validSkill) strongSignals.push('non-empty SKILL.md')
  if (validMcp) strongSignals.push('resolved MCP manifest')
  if (workshopManifest !== undefined) declaredSignals.push('package.json#dshWorkshop')
  if (validWorkshopArtifact) strongSignals.push(`validated Workshop package manifest:${workshopManifest.integration.artifact}`)
  const collectionSignals = []
  if (pluginChildren.length) collectionSignals.push(`plugins/ tree (${new Set(pluginChildren.map((path) => path.split('/')[1])).size} children)`)
  if (packageChildren.length) collectionSignals.push(`packages/ tree (${new Set(packageChildren.map((path) => path.split('/')[1])).size} children)`)
  const evidence = {
    verificationLevel: 'static-default-branch',
    inspectedRef: repository.defaultBranch || 'main',
    declaredSignals,
    strongSignals,
    resolvedRuntimePaths,
    pluginClaims: claims,
    collectionSignals,
    packageManifest: workshopManifest === undefined ? {
      status: 'absent',
      source: null,
      errors: [],
      declaration: null,
      profile: null,
    } : {
      status: validWorkshopArtifact ? 'valid' : 'invalid',
      source: 'package.json#dshWorkshop',
      errors: [...new Set(workshopErrors.length ? workshopErrors : ['declared integration artifact could not be verified'])],
      declaration: workshopManifest,
      profile: validWorkshopArtifact ? capabilityProfile({ declaration: workshopManifest }) : null,
    },
    dependencyCheck,
  }

  if (workshopManifest !== undefined && workshopErrors.length > 0) {
    return review('invalid-workshop-package-manifest', '仓库声明了 Workshop package manifest，但结构、MCP 对齐或证据路径未通过校验。', evidence)
  }
  if (workshopManifest !== undefined && validWorkshopArtifact) {
    return include('verified-workshop-package-manifest', 'package.json#dshWorkshop 已通过结构、协议与制品交叉校验；运行能力仍需当前基线测试。', evidence)
  }
  if (workshopManifest !== undefined) {
    return review('unresolved-workshop-package-artifact', 'Workshop package manifest 合法，但没有解析到相符的插件制品。', evidence)
  }
  if (marketHint) {
    if (marketHint === 'infrastructure'
      && dependencyCheck.hasVersionedProductionHarnessDependency
      && dependencyCheck.linkedFromRuntimeOrManifest
      && resolvedRuntimePaths.length > 0) {
      return market('infrastructure', 'ecosystem-infrastructure', '生态基础设施具有带版本 DSH 生产依赖、真实运行入口和实际依赖引用。', evidence)
    }
    return review(`${marketHint}-needs-source-evidence`, marketHint === 'distribution'
      ? '项目看起来是发行版或插件集合，但仅靠名称和简介不能进入市场层；需要固定来源与人工审核。'
      : '项目看起来是生态基础设施，但缺少带版本 DSH 依赖、真实入口与实际引用的交叉证据。', evidence)
  }
  if (validRepositoryPlugin) {
    return include('verified-plugin-contract', '仓库默认分支中的 Repository Plugin 声明已解析到实际运行资产。', evidence)
  }
  if (validPatch || validDshManifest) {
    if (!dependencyCheck.hasProductionHarnessDependency) {
      return review('missing-production-harness-dependency', '原生 DSH 插件制品没有声明生产、peer 或 optional DSH 依赖，不能只靠 patch 或 manifest 进入 Catalog。', evidence)
    }
    if (!dependencyCheck.hasVersionedProductionHarnessDependency) {
      return review('unbounded-production-harness-dependency', 'DSH 依赖只有 *、latest、workspace 或本地路径等不可核验范围，不能作为公开入库证据。', evidence)
    }
    if (!dependencyCheck.linkedFromRuntimeOrManifest) {
      return review('unlinked-production-harness-dependency', 'package.json 声明了 DSH 依赖，但运行入口、patch 或插件 manifest 没有引用这些依赖。', evidence)
    }
    return include('verified-plugin-contract', '插件制品、带版本的生产 DSH 依赖及其运行接入引用已完成交叉核验。', evidence)
  }
  if ((contents['cordis.patch.yml'] || contents['cordis.patch.yaml']) && validPatch && (deepseekDependencies.length || claims.length)) {
    return include('verified-cordis-plugin', '仓库包含可解析 Cordis patch，并有 DeepSeek Harness 依赖或明确插件接入证据。', evidence)
  }
  if (dependencyCheck.hasVersionedProductionHarnessDependency && dependencyCheck.linkedFromRuntimeOrManifest && claims.length && resolvedRuntimePaths.length) {
    return include('verified-harness-integration', '代码包同时具有 DeepSeek Harness 依赖、明确插件接入声明和可读取运行入口。', evidence)
  }
  if (dependencyCheck.developmentOnlyDoesNotQualify && claims.length && resolvedRuntimePaths.length) {
    return review('development-only-harness-dependency', '只在 devDependencies 中声明 DSH 依赖，不能作为插件运行时接入证据。', evidence)
  }
  if ((validSkill || validMcp) && hasDshClaim && hasPluginClaim) {
    return review('static-extension-needs-workshop-manifest', '发现 Skill 或 MCP 制品，但缺少可交叉核验的 Workshop/MCP 正式 manifest。', evidence)
  }
  if (collectionSignals.length && (claims.length || hasPluginClaim)) {
    return review('plugin-collection-needs-expansion', '仓库看起来是插件集合；必须按真实叶子插件和固定来源展开后才能进入 Catalog。', evidence)
  }
  if (!rootPaths.length && !Object.keys(contents).length) {
    return review('source-scan-unavailable', '本次无法读取公开仓库文件；不能仅凭 Topic、名称或简介判为插件。', evidence)
  }
  if (claims.length || (hasDshClaim && hasPluginClaim)) {
    return review('claimed-plugin-unverified', '仓库声称是 DSH 插件，但没有发现足够的文件级制品证据。', evidence)
  }
  if (hasDshClaim) {
    return review('dsh-project-unverified', '项目名称或简介指向 DSH，但没有发现可核验插件制品。', evidence)
  }
  return exclude('topic-only-traffic', '只有 dsh-plugin Topic 命中，没有 DSH 作品声明或文件级插件证据。', evidence)
}

let completed = 0
let reused = 0
const audits = await mapLimit(snapshot.repositories, AUDIT_CONCURRENCY, async (repository) => {
  const key = repositoryKey(repository)
  const previous = previousByRepository.get(key)
  const sourceFingerprint = repositoryFingerprint(repository)
  const fingerprintUnchanged = previous?.sourceFingerprint
    ? previous.sourceFingerprint === sourceFingerprint
    : Number.isFinite(Date.parse(repository.commitUpdatedAt))
      && Date.parse(repository.commitUpdatedAt) <= Date.parse(previousGeneratedAt)
  const previousCheckedAt = previous?.checkedAt || previousGeneratedAt
  const cacheAge = Date.now() - Date.parse(previousCheckedAt)
  const cacheTTL = previous?.reasonCode === 'source-scan-unavailable' ? 3600000 : 86400000
  const sourceUnchanged = cacheAge < cacheTTL && previousGeneratedAt !== null
    && previous !== undefined
    && previous.defaultBranch === repository.defaultBranch
    && previous.archived === repository.archived
    && (previous.reasonCode !== 'source-scan-unavailable' || !currentCatalogRepositories.has(key))
    && fingerprintUnchanged
    && !MANUAL_DECISIONS.has(key)
  let classification
  if (sourceUnchanged) {
    const { owner, name, url, defaultBranch, archived, evidence, ...cached } = previous
    classification = { ...cached, evidence }
    reused += 1
  } else {
    classification = await inspect(repository)
  }
  if (classification.reasonCode === 'source-scan-unavailable' && currentCatalogByRepository.has(key)) {
    const catalogProjects = currentCatalogByRepository.get(key)
    const preservedProfile = catalogProjects.find((project) => project.workshop)?.workshop || null
    classification = include(
      'verified-catalog-refresh-pending',
      '该仓库已有文件级 Catalog 证据；本次公开原始文件端点不可达，因此保留展示并等待重新扫描，不提升任何验证或安装状态。',
      {
        verificationLevel: 'preserved-catalog-evidence',
        strongSignals: [...new Set(catalogProjects.map((project) => project.workshop?.manifest?.source || project.discovery?.qualification).filter(Boolean))],
        pluginClaims: [...new Set(catalogProjects.map((project) => project.workshop?.integration?.protocol).filter(Boolean))],
        refresh: { state: 'unavailable', attemptedAt: snapshot.generatedAt },
        packageManifest: preservedProfile ? {
          status: preservedProfile.manifest?.status || 'legacy-evidence',
          source: preservedProfile.manifest?.source || 'preserved-catalog-evidence',
          errors: ['public source refresh unavailable'],
          declaration: null,
          profile: preservedProfile,
        } : {
          status: 'absent', source: null, errors: ['public source refresh unavailable'], declaration: null, profile: null,
        },
        dependencyCheck: {},
      },
    )
  }
  const creation = repositoryCreationPolicy(repository)
  completed += 1
  if (completed % 25 === 0 || completed === snapshot.repositories.length) {
    process.stderr.write(`audited ${completed}/${snapshot.repositories.length}\n`)
  }
  return {
    repositoryId: Number.isSafeInteger(repository.repositoryId) ? repository.repositoryId : null,
    owner: repository.owner,
    name: repository.name,
    url: repository.url,
    defaultBranch: repository.defaultBranch,
    archived: repository.archived,
    sourceFingerprint,
    ...classification,
    checkedAt: sourceUnchanged ? previousCheckedAt : new Date().toISOString(),
    evidence: {
      ...classification.evidence,
      creation,
      topicClaim: {
        descriptionPresent: Boolean(repository.description),
        explicitDshClaim: DSH_RE.test(productText(repository)) || /(?:^|[-_.])dsh(?:[-_.]|$)|deepseek[-_.]?harness/i.test(repository.name),
        explicitPluginClaim: PLUGIN_WORD_RE.test(productText(repository)),
      },
      sourceSnapshot: {
        commitUpdatedAt: repository.commitUpdatedAt,
        metadataUpdatedAt: repository.metadataUpdatedAt,
        reusedFromAudit: sourceUnchanged ? previousGeneratedAt : null,
      },
    },
  }
})

function countBy(field) {
  return Object.fromEntries([...new Set(audits.map((entry) => entry[field]).filter((value) => value !== null))]
    .sort()
    .map((value) => [value, audits.filter((entry) => entry[field] === value).length]))
}

const report = {
  schema: 'omdsh-topic-plugin-audit/v3',
  engineVersion: ENGINE_VERSION,
  generatedAt: snapshot.generatedAt,
  topic: snapshot.topic,
  sourceSnapshotGeneratedAt: snapshot.generatedAt,
  incremental: {
    previousAuditGeneratedAt: previousGeneratedAt,
    reusedRepositories: reused,
    rescannedRepositories: audits.length - reused,
    reuseRule: 'unchanged repository and branch, at most 24 hours since source observation; unavailable sources retry after one hour',
  },
  policy: {
    plugin: 'package.json#dshWorkshop is the preferred admission contract. Legacy file-level plugin artifacts remain visible only as compatibility-mapped entries that need a manifest and current-baseline tests.',
    creation: `Community plugin repositories must be created at or after ${COMMUNITY_PLUGIN_CREATED_AT_CUTOFF}. Official exemptions are limited to explicit owners: ${OFFICIAL_REPOSITORY_OWNERS.join(', ')}. Missing created_at fails closed.`,
    dependencies: 'Native community plugins need a versioned production, peer, or optional @deepseek-ai/dsh dependency that is referenced by a runtime entry, patch, or plugin manifest. Wildcard/workspace/local specs and devDependencies never qualify a project by themselves. MCP, Skill, and Repository Plugin use their protocol-specific manifests.',
    review: 'Topic, name, description, README claims, unavailable scans, and unexpanded collections remain discovery-only review leads outside the Catalog.',
    market: 'Genuine DSH clients, managers, marketplaces, developer tools, integrations, plugin collections, and distributions remain in non-plugin market layers.',
    excluded: 'Core products, Awesome/documentation, templates/placeholders, archived sources, and Topic-only popularity matches remain outside the market.',
    registry: 'A valid manifest is author declaration, not execution evidence. Static file evidence grants neither RC.6 compatibility nor Registry installation authority.',
  },
  stats: {
    repositories: audits.length,
    decisions: countBy('decision'),
    reasons: countBy('reasonCode'),
    qualifications: countBy('qualification'),
    marketLayers: countBy('marketLayer'),
  },
  repositories: audits,
}

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report.stats, null, 2))
