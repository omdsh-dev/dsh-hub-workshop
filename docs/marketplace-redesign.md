# Hub marketplace redesign · September 2026

Hub is an open discovery surface for DSH plugins, with its own source observations. Marketplace listings are distinct from the signed installation Registry: being listed does not imply runtime testing, approval, or a safe installation.

## Design references

The redesign studied five Awwwards winners. It borrows general layout and interaction principles, not their graphics, markup, or branding:

- [Cosmos](https://www.awwwards.com/sites/cosmos): room for a browsable collection, calm typography, content first.
- [Editorial New](https://www.awwwards.com/editorial-new-variable-typeface-by-locomotive-wins-site-of-the-month-october.html): expressive typography and asymmetric editorial spacing.
- [Superlist](https://www.awwwards.com/sites/superlist): clear product interactions and a restrained accent.
- [Contra Project Calculator](https://www.awwwards.com/sites/contra-project-calculator): legible controls and a direct path from intent to result.
- [BlueYard Capital](https://www.awwwards.com/sites/blueyard-capital): deliberate scale and contrast.

The final brand takes its lavender accent, dark ink, and official orca asset from [Oh My DSH](https://omdsh.dev/). Hub has a simple typographic wordmark. The organization mark remains unmodified, used for attribution and the favicon. No composite or puzzle logo is used. Font files are self-hosted, with their license alongside them.

## Discovery and probe freshness

`discover.yml` runs every six hours. It reads GitHub's public `dsh-plugin` Topic using adaptive creation-time partitions to stay below Search's 1,000-result cap. A local, ignored checkpoint supports resuming interrupted fetches for up to six hours. Source audits expire after 24 hours; unavailable-source results retry after one hour. A source push or official DSH release also invalidates marketplace probe reuse.

`market:refresh` observes the latest official `@deepseek-ai/dsh` release and resolves the exact pinned DSH component dependency graph from npm manifests. Dependency comparison prefers versions in that runtime. For a component absent from that graph, it labels the npm `latest` fallback explicitly. A component's dist-tag can lag the version that DSH actually bundles.

Probes read public root `package.json` and any safely located declared patch entry. They never install or execute third-party plugins. Records include attempt time, successful-read time, observed source update, runtime baseline, and failure states. Failed reads retain dated previous evidence without claiming a fresh success. The UI marks old observations due and explains the limits of root-manifest coverage for monorepos and skill directories.

Validated snapshots are committed to `main`, then explicitly dispatch the signed deployment workflow. This avoids the old state in which scheduled refreshes only created unmerged PRs. The live check compares the exact published marketplace snapshot with the release and verifies the signed Registry independently.

Search, categories, sorting, list/card views, pagination, bilingual labels, dark/light themes, source detail dialogs, copyable links, keyboard access, and reduced-motion preferences are implemented without a client framework. No dshfind UI, source code, or data is used by the new marketplace refresh.

## Delivery performance

The initial catalog uses a compact column-based index. Full probe records load on demand from one of 64 deterministic shards, and each shard must match the index snapshot timestamp. The full machine-readable feed remains available. Source JSON is minified for deployment and every public asset is checked against the host file-size limit.
