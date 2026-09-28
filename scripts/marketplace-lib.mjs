import semver from "semver";

export const PROBE_VERSION = 3;
export const probeTTL = 24 * 60 * 60 * 1000;
export const retryTTL = 60 * 60 * 1000;

export function categoryFor(repository) {
  const text = `${repository.name} ${repository.description} ${(repository.topics || []).join(" ")}`;
  for (const [id, expression] of [
    ["memory", /memory|context|session|记忆|上下文|会话/i],
    [
      "channels",
      /telegram|feishu|wechat|discord|slack|channel|飞书|微信|消息|渠道/i,
    ],
    ["interface", /theme|sidebar|panel|skin|web-ui|界面|主题|皮肤|桌面/i],
    ["safety", /security|guard|audit|permission|安全|权限|审计/i],
    ["workflow", /workflow|agent|team|plan|task|工作流|任务|协作/i],
    ["tools", /tool|search|browser|mcp|搜索|工具|浏览器/i],
  ])
    if (expression.test(text)) return id;
  return "extensions";
}

export function dueForProbe(previous, repository, baseline, now = Date.now()) {
  if (
    !previous ||
    previous.engine !== PROBE_VERSION ||
    previous.sourceUpdatedAt !== repository.commitUpdatedAt ||
    previous.baseline !== baseline
  )
    return true;
  const ttl = ["unavailable", "artifact-unavailable"].includes(previous.state)
    ? retryTTL
    : probeTTL;
  return (
    !Number.isFinite(Date.parse(previous.attemptedAt)) ||
    now - Date.parse(previous.attemptedAt) >= ttl
  );
}

export function inspectManifest(manifest, versions) {
  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object")
    return { state: "missing", dependencies: [] };
  const declarations = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
  const dependencies = Object.entries(declarations)
    .filter(([name]) => /^@deepseek-ai\/dsh(?:-|$)/.test(name))
    .map(([name, range]) => {
      const reference = versions[name];
      const version =
        typeof reference === "string" ? reference : reference?.version || null;
      const valid = typeof range === "string" && semver.validRange(range);
      return {
        name,
        range: String(range).slice(0, 160),
        latest: version,
        reference:
          typeof reference === "object"
            ? reference?.source || "npm-latest"
            : "npm-latest",
        matchesLatest:
          version && valid ? semver.satisfies(version, range) : null,
      };
    });
  const declared = Boolean(
    manifest.dsh || manifest.dshWorkshop || dependencies.length,
  );
  return {
    state: !declared
      ? "unconfirmed"
      : dependencies.some((d) => d.matchesLatest === false)
        ? "mismatch"
        : "declared",
    version: typeof manifest.version === "string" ? manifest.version : null,
    license: typeof manifest.license === "string" ? manifest.license : null,
    dependencies,
    entry:
      typeof manifest.dsh?.bundle?.patch === "string"
        ? manifest.dsh.bundle.patch
        : null,
  };
}

export function safeArtifactPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length < 240 &&
    !path.includes("\\") &&
    !path.includes("..") &&
    !path.startsWith("/") &&
    !path.includes(":") &&
    !/[?#\s]/.test(path)
  );
}

export function preserveFailedProbe(previous, metadata) {
  return {
    ...metadata,
    state: "unavailable",
    checkedAt: null,
    lastObservation:
      previous?.state === "unavailable"
        ? previous.lastObservation || null
        : previous || null,
  };
}

export function validateMarketplace(data, snapshot) {
  if (
    data?.schema !== "dsh-hub-marketplace/v1" ||
    !Array.isArray(data.projects) ||
    !semver.valid(data.official?.version) ||
    !Number.isFinite(Date.parse(data.generatedAt)) ||
    data.discoveryAt !== snapshot.generatedAt ||
    data.policy?.runtimeTested !== false ||
    data.totals.listed !== data.projects.length ||
    data.totals.discovered !== snapshot.repositories.length
  ) {
    throw new Error(
      "Marketplace must match its discovery snapshot and current npm observation",
    );
  }
  const sources = new Map(
    snapshot.repositories.map((r) => [`${r.owner}/${r.name}`, r]),
  );
  const seen = new Set();
  const states = new Set([
    "missing",
    "invalid",
    "unconfirmed",
    "declared",
    "mismatch",
    "artifact-missing",
    "artifact-unavailable",
    "unavailable",
  ]);
  for (const project of data.projects) {
    const source = sources.get(project.id),
      probe = project.probe;
    if (
      seen.has(project.id) ||
      !source ||
      project.repository !== source.url ||
      !states.has(probe?.state) ||
      probe.runtimeTested !== false ||
      probe.engine !== PROBE_VERSION ||
      probe.baseline !== data.official.version ||
      probe.sourceUpdatedAt !== source.commitUpdatedAt ||
      !Number.isFinite(Date.parse(probe.attemptedAt)) ||
      (probe.checkedAt !== null &&
        !Number.isFinite(Date.parse(probe.checkedAt))) ||
      (probe.state === "unavailable" && probe.checkedAt !== null)
    ) {
      throw new Error(
        `Invalid or mismatched marketplace observation: ${project.id}`,
      );
    }
    seen.add(project.id);
  }
}

export function isMarketplaceCandidate(audit) {
  if (audit?.decision === "include") return true;
  if (audit?.decision !== "review") return false;
  if (
    [
      "development-only-harness-dependency",
      "invalid-workshop-package-manifest",
      "missing-production-harness-dependency",
      "unbounded-production-harness-dependency",
      "unlinked-production-harness-dependency",
      "unresolved-workshop-package-artifact",
      "static-extension-needs-workshop-manifest",
    ].includes(audit.reasonCode)
  )
    return true;
  return (
    ["claimed-plugin-unverified", "source-scan-unavailable"].includes(
      audit.reasonCode,
    ) &&
    audit.evidence?.topicClaim?.explicitDshClaim === true &&
    audit.evidence?.topicClaim?.explicitPluginClaim === true
  );
}
