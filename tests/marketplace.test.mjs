import test from "node:test";
import assert from "node:assert/strict";
import {
  dueForProbe,
  inspectManifest,
  preserveFailedProbe,
  safeArtifactPath,
  PROBE_VERSION,
  validateMarketplace,
  isMarketplaceCandidate,
} from "../scripts/marketplace-lib.mjs";

const now = Date.parse("2026-09-28T12:00:00Z");
const repository = { commitUpdatedAt: "2026-09-27T00:00:00Z" };
const recent = {
  engine: PROBE_VERSION,
  baseline: "1.2.0",
  sourceUpdatedAt: repository.commitUpdatedAt,
  attemptedAt: new Date(now - 2 * 3600000).toISOString(),
  state: "declared",
};
test("cached observations expire and react to source or runtime changes", () => {
  assert.equal(dueForProbe(recent, repository, "1.2.0", now), false);
  assert.equal(dueForProbe(recent, repository, "1.3.0", now), true);
  assert.equal(
    dueForProbe(
      recent,
      { commitUpdatedAt: "2026-09-28T10:00:00Z" },
      "1.2.0",
      now,
    ),
    true,
  );
  assert.equal(
    dueForProbe(recent, repository, "1.2.0", now + 24 * 3600000),
    true,
  );
  assert.equal(
    dueForProbe({ ...recent, state: "unavailable" }, repository, "1.2.0", now),
    true,
  );
  assert.equal(
    dueForProbe(
      { ...recent, state: "artifact-unavailable" },
      repository,
      "1.2.0",
      now,
    ),
    true,
  );
});
test("dependency checks respect semver prereleases and never claim runtime execution", () => {
  const manifest = {
    dependencies: { "@deepseek-ai/dsh": "^0.1.0-rc.6" },
    devDependencies: { "@deepseek-ai/dsh-tool": "*" },
  };
  const compatible = inspectManifest(manifest, {
    "@deepseek-ai/dsh": "0.1.0-rc.8",
  });
  assert.equal(compatible.state, "declared");
  assert.equal(compatible.dependencies.length, 1);
  assert.equal(compatible.dependencies[0].matchesLatest, true);
  assert.equal(
    inspectManifest(manifest, { "@deepseek-ai/dsh": "0.2.0" }).state,
    "mismatch",
  );
  assert.equal(
    inspectManifest(
      { dependencies: { "@deepseek-ai/dsh": "workspace:*" } },
      { "@deepseek-ai/dsh": "0.1.0" },
    ).dependencies[0].matchesLatest,
    null,
  );
  assert.equal(
    inspectManifest({ devDependencies: { "@deepseek-ai/dsh": "*" } }, {}).state,
    "unconfirmed",
  );
});
test("source outages preserve dated evidence without giving it a fresh successful timestamp", () => {
  const first = preserveFailedProbe(
    { ...recent, checkedAt: recent.attemptedAt },
    { attemptedAt: new Date(now).toISOString() },
  );
  const second = preserveFailedProbe(first, {
    attemptedAt: new Date(now + 1000).toISOString(),
  });
  assert.equal(first.checkedAt, null);
  assert.deepEqual(second.lastObservation, first.lastObservation);
  assert.equal(second.lastObservation.checkedAt, recent.attemptedAt);
});
test("artifact probes cannot escape the repository or introduce query strings", () => {
  for (const path of [
    "../secret",
    "/etc/passwd",
    "https://example.com/file",
    "file?token=secret",
    "dir\\file",
    "patch.yml#x",
    "",
  ])
    assert.equal(safeArtifactPath(path), false, path);
  assert.equal(safeArtifactPath("./dist/patch.yml"), true);
});
test("public data validation rejects a snapshot from a different discovery generation", () => {
  assert.throws(
    () =>
      validateMarketplace(
        {
          schema: "dsh-hub-marketplace/v1",
          projects: [],
          official: { version: "1.0.0" },
          generatedAt: new Date(now).toISOString(),
          discoveryAt: "old",
          policy: { runtimeTested: false },
          totals: { listed: 0, discovered: 0 },
        },
        { generatedAt: "new", repositories: [] },
      ),
    /snapshot/,
  );
});

test("marketplace excludes infrastructure and topic-only claims even when source reads fail", () => {
  assert.equal(
    isMarketplaceCandidate({
      decision: "review",
      reasonCode: "infrastructure-needs-source-evidence",
    }),
    false,
  );
  assert.equal(
    isMarketplaceCandidate({
      decision: "review",
      reasonCode: "source-scan-unavailable",
      evidence: {
        topicClaim: { explicitDshClaim: false, explicitPluginClaim: true },
      },
    }),
    false,
  );
  assert.equal(
    isMarketplaceCandidate({
      decision: "review",
      reasonCode: "claimed-plugin-unverified",
      evidence: {
        topicClaim: { explicitDshClaim: true, explicitPluginClaim: true },
      },
    }),
    true,
  );
  assert.equal(isMarketplaceCandidate({ decision: "include" }), true);
});

test("published runtime versions take precedence over lagging component dist-tags", () => {
  const observed = inspectManifest(
    { dependencies: { "@deepseek-ai/dsh-agent": "^0.1.7-rc.2" } },
    {
      "@deepseek-ai/dsh-agent": { version: "0.1.7-rc.2", source: "runtime" },
    },
  );
  assert.equal(observed.state, "declared");
  assert.equal(observed.dependencies[0].matchesLatest, true);
  assert.equal(observed.dependencies[0].reference, "runtime");
});

test('compact marketplace index preserves identities and routes details to the same snapshot', async () => {
  const { marketplaceAssets } = await import('../scripts/marketplace-assets.mjs');
  const projects = ['alice/one', 'bob/two'].map(id => ({id, probe: { state: 'declared', checkedAt: '2026-09-28T00:00:00Z', dependencies: [{ name: 'example', range: '^1' }] }}));
  const data = { generatedAt: '2026-09-28T01:00:00Z', projects };
  const files = marketplaceAssets(data);
  const index = files.get('market-index.json');
  for (const row of index.rows) {
    const p = Object.fromEntries(index.columns.map((key, i) => [key, row[i]]));
    assert.equal(p.probe.dependencies, undefined);
    const details = files.get(`market-details/${p.detailShard}.json`);
    assert.equal(details.generatedAt, data.generatedAt);
    assert.deepEqual(details.projects[p.id], projects.find(source => source.id === p.id));
  }
});
