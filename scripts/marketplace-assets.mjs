export const MARKET_SHARDS = 64;
export const MARKET_ASSETS = ['market-index.json', ...Array.from({ length: MARKET_SHARDS }, (_, n) => `market-details/${n}.json`)];
const columns = ['id', 'summary', 'stars', 'createdAt', 'updatedAt', 'category', 'kind', 'topics', 'aliases', 'evidence', 'archived', 'probe', 'detailShard'];
export function marketplaceAssets(data) {
  const shards = Array.from({ length: MARKET_SHARDS }, () => ({ generatedAt: data.generatedAt, projects: {} }));
  const rows = data.projects.map((project) => {
    let hash = 0;
    for (const c of project.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    const detailShard = hash % MARKET_SHARDS;
    shards[detailShard].projects[project.id] = project;
    const slim = { ...project, detailShard, probe: { state: project.probe.state, checkedAt: project.probe.checkedAt } };
    return columns.map(key => slim[key]);
  });
  const { projects, ...meta } = data;
  return new Map([
    ['market-index.json', { ...meta, schema: 'dsh-hub-market-index/v1', columns, rows }],
    ...shards.map((value, n) => [`market-details/${n}.json`, value]),
  ]);
}
