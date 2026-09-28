#!/usr/bin/env node
import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder("ipv4first");
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import semver from "semver";
import {
  PROBE_VERSION,
  categoryFor,
  dueForProbe,
  inspectManifest,
  preserveFailedProbe,
  safeArtifactPath,
  isMarketplaceCandidate,
} from "./marketplace-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (name) => readFile(resolve(root, name), "utf8").then(JSON.parse);
const [snapshot, audit, catalog, previous] = await Promise.all([
  read("topic-repositories.json"),
  read("topic-plugin-audit.json"),
  read("catalog.json"),
  read("marketplace.json").catch(() => null),
]);
const auditByURL = new Map(
  audit.repositories.map((r) => [r.url.toLowerCase(), r]),
);
const catalogByURL = new Map();
for (const entry of catalog.packages) {
  const key = entry.repository.toLowerCase();
  catalogByURL.set(key, [...(catalogByURL.get(key) || []), entry]);
}
const previousById = new Map((previous?.projects || []).map((r) => [r.id, r]));
const versions = new Map();
async function request(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { "user-agent": "DSH-Hub-Independent-Probe/1.0" },
      });
      if (response.status === 404) return { missing: true };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const source = await response.text();
      if (source.length > 1500000) throw new Error("oversized response");
      return { source };
    } catch (error) {
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
      if (attempt === 2)
        return {
          error:
            error.name === "TimeoutError" ? "timeout" : "source-unavailable",
        };
    }
  }
}
function latest(name) {
  if (!versions.has(name))
    versions.set(
      name,
      (async () => {
        const value = await request(
          `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
        );
        try {
          return JSON.parse(value.source).version || null;
        } catch {
          return null;
        }
      })(),
    );
  return versions.get(name);
}
const startedAt = new Date().toISOString();
const rootRelease = await request(
  "https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest",
);
let runtimeManifest;
try {
  runtimeManifest = JSON.parse(rootRelease.source);
} catch {}
const runtime = runtimeManifest?.version;
if (!semver.valid(runtime))
  throw new Error(
    "Cannot observe the official runtime; keeping the last successful snapshot",
  );
// Resolve the published runtime's actual dependency graph. Component dist-tags
// can lag behind versions pinned by DSH and must not drive incompatibility claims.
const bundled = new Map([["@deepseek-ai/dsh", new Set([runtime])]]);
const visited = new Set();
let frontier = [runtimeManifest];
while (frontier.length) {
  const pending = [];
  for (const manifest of frontier) {
    for (const [name, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      if (!/^@deepseek-ai\/dsh(?:-|$)/.test(name) || !semver.valid(version))
        continue;
      if (!bundled.has(name)) bundled.set(name, new Set());
      bundled.get(name).add(version);
      const key = `${name}@${version}`;
      if (!visited.has(key)) {
        visited.add(key);
        pending.push([name, version]);
      }
    }
  }
  if (visited.size > 600)
    throw new Error("Unexpectedly large official dependency graph");
  frontier = [];
  for (let index = 0; index < pending.length; index += 16) {
    const manifests = await Promise.all(
      pending.slice(index, index + 16).map(async ([name, version]) => {
        const result = await request(
          `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
        );
        let manifest;
        try {
          manifest = JSON.parse(result.source);
        } catch {}
        if (manifest?.version !== version)
          throw new Error(
            `Cannot resolve published runtime dependency ${name}@${version}`,
          );
        return manifest;
      }),
    );
    frontier.push(...manifests);
  }
}
console.log(
  `Observed official DSH ${runtime}: ${bundled.size} bundled components`,
);
async function referenceFor(name) {
  const included = bundled.get(name);
  if (included?.size === 1)
    return { version: [...included][0], source: "runtime" };
  return { version: await latest(name), source: "npm-latest" };
}
const sources = snapshot.repositories.filter((r) => {
  const a = auditByURL.get(r.url.toLowerCase());
  return isMarketplaceCandidate(a);
});
let cursor = 0,
  scanned = 0;
const projects = new Array(sources.length);
await Promise.all(
  Array.from({ length: 24 }, async () => {
    while (cursor < sources.length) {
      const index = cursor++,
        repository = sources[index];
      const id = `${repository.owner}/${repository.name}`;
      const old = previousById.get(id)?.probe;
      const a = auditByURL.get(repository.url.toLowerCase());
      const aliases = catalogByURL.get(repository.url.toLowerCase()) || [];
      const c = aliases[0];
      let probe = old;
      if (dueForProbe(old, repository, runtime) || (process.env.HUB_RETRY_UNAVAILABLE === "1" && ["unavailable", "artifact-unavailable"].includes(old?.state))) {
        const attemptedAt = new Date().toISOString();
        const metadata = {
          engine: PROBE_VERSION,
          baseline: runtime,
          sourceUpdatedAt: repository.commitUpdatedAt,
          ref: repository.defaultBranch,
          attemptedAt,
          checkedAt: attemptedAt,
          method: "public-manifest-and-artifact",
          runtimeTested: false,
        };
        const base = `https://raw.githubusercontent.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/${encodeURIComponent(repository.defaultBranch)}/`;
        const result = await request(`${base}package.json`);
        if (result.error) probe = preserveFailedProbe(old, metadata);
        else if (result.missing)
          probe = { ...metadata, state: "missing", dependencies: [] };
        else {
          let manifest;
          try {
            manifest = JSON.parse(result.source);
          } catch {}
          if (
            !manifest ||
            Array.isArray(manifest) ||
            typeof manifest !== "object"
          )
            probe = { ...metadata, state: "invalid", dependencies: [] };
          else {
            const names = Object.keys({
              ...manifest.dependencies,
              ...manifest.peerDependencies,
              ...manifest.optionalDependencies,
            }).filter((n) => /^@deepseek-ai\/dsh(?:-|$)/.test(n));
            const resolved = Object.fromEntries(
              await Promise.all(
                names.map(async (n) => [n, await referenceFor(n)]),
              ),
            );
            probe = { ...metadata, ...inspectManifest(manifest, resolved) };
            if (probe.entry && safeArtifactPath(probe.entry)) {
              const entry = await request(
                base +
                  probe.entry
                    .replace(/^\.\//, "")
                    .split("/")
                    .map(encodeURIComponent)
                    .join("/"),
              );
              probe.artifact = entry.error
                ? "unavailable"
                : entry.missing
                  ? "missing"
                  : "present";
              if (probe.artifact === "missing")
                probe.state = "artifact-missing";
              if (probe.artifact === "unavailable")
                probe.state = "artifact-unavailable";
            }
          }
        }
        scanned++;
        if (scanned % 100 === 0)
          console.log(`Probed ${scanned}/${sources.length} public manifests`);
      }
      // Package names are not needed for repository-based discovery and can carry
      // historical private registry namespaces; keep the published probe minimal.
      if (probe.name !== undefined) {
        probe = { ...probe };
        delete probe.name;
      }
      if (probe.lastObservation?.name !== undefined) {
        probe.lastObservation = { ...probe.lastObservation };
        delete probe.lastObservation.name;
      }
      projects[index] = {
        id,
        aliases: aliases.map((entry) => entry.id),
        name: repository.name,
        author: repository.owner,
        summary: repository.description,
        repository: repository.url,
        branch: repository.defaultBranch,
        stars: repository.stars,
        archived: repository.archived,
        createdAt: repository.createdAt,
        updatedAt: repository.commitUpdatedAt,
        category: categoryFor(repository),
        kind:
          c?.kind ||
          (/mcp/i.test(repository.name)
            ? "mcp"
            : /skill/i.test(repository.name)
              ? "skill"
              : "extension"),
        topics: repository.topics.filter((t) => t !== "dsh-plugin").slice(0, 6),
        evidence: a.decision === "include" ? "source-found" : "unconfirmed",
        probe,
      };
    }
  }),
);
projects.sort(
  (a, b) => b.stars - a.stars || b.updatedAt.localeCompare(a.updatedAt),
);
const payload = {
  schema: "dsh-hub-marketplace/v1",
  generatedAt: new Date().toISOString(),
  discoveryAt: snapshot.generatedAt,
  probeStartedAt: startedAt,
  official: {
    package: "@deepseek-ai/dsh",
    version: runtime,
    bundledComponents: bundled.size,
    checkedAt: startedAt,
    source: "https://www.npmjs.com/package/@deepseek-ai/dsh",
  },
  policy: {
    scheduleHours: 6,
    probeMaxAgeHours: 24,
    source: "GitHub dsh-plugin topic and public repository files",
    runtimeTested: false,
  },
  totals: {
    discovered: snapshot.repositories.length,
    listed: projects.length,
    sourceFound: projects.filter((p) => p.evidence === "source-found").length,
    probed: projects.filter((p) => p.probe.checkedAt).length,
    unavailable: projects.filter((p) => p.probe.state === "unavailable").length,
    refreshed: scanned,
  },
  projects,
};
await writeFile(
  resolve(root, "marketplace.json.tmp"),
  JSON.stringify(payload) + "\n",
);
await rename(
  resolve(root, "marketplace.json.tmp"),
  resolve(root, "marketplace.json"),
);
console.log(
  `Marketplace ready: ${projects.length} projects, ${scanned} probes refreshed, official runtime ${runtime}`,
);
