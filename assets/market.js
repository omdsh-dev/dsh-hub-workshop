const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};
let locale = storage.get("dsh-hub-locale") || "zh";
const t = (zh, en) => (locale === "en" ? en : zh);
const categories = [
  ["all", "全部插件", "All plugins"],
  ["workflow", "工作流", "Workflows"],
  ["tools", "工具与搜索", "Tools & search"],
  ["memory", "记忆与会话", "Memory"],
  ["channels", "消息渠道", "Channels"],
  ["interface", "界面体验", "Interface"],
  ["safety", "安全与权限", "Security"],
  ["extensions", "更多扩展", "More"],
];
const params = new URLSearchParams(location.search);
const state = {
  category: params.get("category") || "all",
  query: params.get("q") || "",
  sort: params.get("sort") || "stars",
  page: 1,
  confirmed: params.get("evidence") === "1",
  view: storage.get("hub-view") || "grid",
};
if (!categories.some((c) => c[0] === state.category)) state.category = "all";
if (!["stars", "updated", "created", "name"].includes(state.sort))
  state.sort = "stars";
let data,
  activeProject,
  lastOpener,
  loading = false,
  toastTimer;
const pageSize = 12;
const date = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : t("未记录", "Not recorded");
const shortDate = (value) =>
  value
    ? new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "zh-CN", {
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(value))
    : "—";
const number = (n) =>
  new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-CN").format(n || 0);
function stale(probe) {
  return (
    !probe?.checkedAt || Date.now() - Date.parse(probe.checkedAt) > 24 * 3600000
  );
}
function status(project) {
  const probe = project.probe;
  if (project.archived) return [t("已归档", "Archived"), ""];
  if (["unavailable", "artifact-unavailable"].includes(probe?.state))
    return [t("暂时无法探测", "Probe unavailable"), "warn"];
  if (stale(probe)) return [t("待重新探测", "Probe due"), ""];
  return (
    {
      declared: [t("发现插件声明", "Declaration found"), "good"],
      mismatch: [t("版本范围有差异", "Version range differs"), "warn"],
      "artifact-missing": [t("入口文件缺失", "Entry file missing"), "warn"],
      missing: [t("未发现根清单", "No root manifest"), ""],
      invalid: [t("清单格式异常", "Invalid manifest"), "warn"],
      unconfirmed: [t("待确认", "Unconfirmed"), ""],
    }[probe.state] || [t("待探测", "Pending"), ""]
  );
}
function updateURL() {
  const url = new URL(location.href);
  for (const [key, value] of [
    ["q", state.query],
    ["category", state.category === "all" ? "" : state.category],
    ["sort", state.sort === "stars" ? "" : state.sort],
    ["evidence", state.confirmed ? "1" : ""],
  ])
    value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
  history.replaceState(null, "", url);
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 2800);
}
function applyTheme(value) {
  document.documentElement.dataset.theme = value;
  $("#theme-toggle").setAttribute(
    "aria-label",
    t("切换到", "Switch to ") +
      (value === "dark"
        ? t("浅色主题", "light theme")
        : t("深色主题", "dark theme")),
  );
}
const media = matchMedia("(prefers-color-scheme: dark)");
applyTheme(storage.get("dsh-hub-theme") || (media.matches ? "dark" : "light"));
media.addEventListener("change", (e) => {
  if (!storage.get("dsh-hub-theme")) applyTheme(e.matches ? "dark" : "light");
});
$("#theme-toggle").addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  storage.set("dsh-hub-theme", next);
  applyTheme(next);
});
function localize() {
  document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
  applyTheme(document.documentElement.dataset.theme);
  document.title = t("Hub · DSH 插件市场", "Hub · The DSH plugin marketplace");
  $(".skip").textContent = t("跳到插件目录", "Skip to plugin directory");
  for (const [selector, zh, en] of [
    [".market-header .hub-wordmark", "Hub 首页", "Hub home"],
    [".market-header nav", "主导航", "Main navigation"],
    ["#search-form button", "搜索", "Search"],
    ["#categories", "插件分类", "Plugin categories"],
    ["#sort", "排序方式", "Sort by"],
    ["[data-view=grid]", "卡片视图", "Card view"],
    ["[data-view=list]", "列表视图", "List view"],
    ["#catalog-pagination", "目录分页", "Directory pages"],
    ["footer nav", "更多资源", "More resources"],
  ])
    $(selector).setAttribute("aria-label", t(zh, en));
  $("label[for=sort]").textContent = t("排序方式", "Sort by");

  $$("[data-zh]").forEach(
    (el) => (el.textContent = el.dataset[locale].replaceAll("\\n", "\n")),
  );
  $("#locale-toggle").textContent = locale === "en" ? "中文" : "EN";
  $("#locale-toggle").setAttribute(
    "aria-label",
    locale === "en" ? "切换为中文" : "Switch to English",
  );
  $("#market-search").placeholder = t(
    "搜索名字、作者，或你想做的事…",
    "Search a name, creator, or something you want to do…",
  );
  $("#market-search").setAttribute(
    "aria-label",
    t("搜索插件、作者或功能", "Search plugins, creators or features"),
  );
  const labels = [
    t("最多收藏", "Most stars"),
    t("最近更新", "Recently updated"),
    t("最近创建", "Newest projects"),
    t("名称排序", "Name A–Z"),
  ];
  Array.from($("#sort").options).forEach((o, i) => (o.textContent = labels[i]));
  $("#detail-close").setAttribute("aria-label", t("关闭详情", "Close details"));
  render();
  if ($("#detail-dialog").open)
    activeProject ? renderDetail(activeProject) : renderSync();
}
$("#locale-toggle").addEventListener("click", () => {
  locale = locale === "zh" ? "en" : "zh";
  storage.set("dsh-hub-locale", locale);
  localize();
});
function render() {
  if (!data) return;
  $("#categories").innerHTML = categories
    .map(
      ([id, zh, en]) =>
        `<button data-category="${id}" aria-pressed="${state.category === id}">${escape(t(zh, en))}<small>${number(data.projects.filter((p) => id === "all" || p.category === id).length)}</small></button>`,
    )
    .join("");
  const q = state.query.trim().toLocaleLowerCase();
  let projects = data.projects.filter(
    (p) =>
      (state.category === "all" || p.category === state.category) &&
      (!state.confirmed || p.evidence === "source-found") &&
      (!q ||
        `${p.name} ${p.author} ${p.summary} ${(p.topics || []).join(" ")}`
          .toLocaleLowerCase()
          .includes(q)),
  );
  projects.sort((a, b) =>
    state.sort === "stars"
      ? b.stars - a.stars || b.updatedAt.localeCompare(a.updatedAt)
      : state.sort === "name"
        ? a.name.localeCompare(b.name)
        : String(
            b[state.sort === "updated" ? "updatedAt" : "createdAt"],
          ).localeCompare(
            String(a[state.sort === "updated" ? "updatedAt" : "createdAt"]),
          ),
  );
  const pages = Math.ceil(projects.length / pageSize);
  state.page = Math.max(1, Math.min(state.page, pages || 1));
  const visible = projects.slice(
    (state.page - 1) * pageSize,
    state.page * pageSize,
  );
  $("#result-count").innerHTML =
    `<strong>${number(projects.length)}</strong> ${t("款插件", projects.length === 1 ? "plugin" : "plugins")}${q ? ` · ${escape(state.query)}` : ""}`;
  const outdated = Date.now() - Date.parse(data.generatedAt) > 12 * 3600000;
  $("#sync-label").textContent =
    `${t(outdated ? "快照待更新 · " : "快照更新于 ", outdated ? "Snapshot overdue · " : "Updated ")}${shortDate(data.generatedAt)} ${new Date(data.generatedAt).toLocaleTimeString(locale === "en" ? "en-GB" : "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  $("#project-grid").classList.toggle("list-view", state.view === "list");
  $("#project-grid").setAttribute("aria-busy", "false");
  $$("[data-view]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.view === state.view)),
  );
  $("#project-grid").innerHTML = visible.length
    ? visible
        .map((p) => {
          const [label, tone] = status(p);
          const monogram =
            p.name
              .replace(/^dsh[-_]?/i, "")
              .slice(0, 2)
              .toUpperCase() || "D";
          return `<article class="project-card"><div class="card-top"><span class="project-monogram" aria-hidden="true">${escape(monogram)}</span><span class="stars" aria-label="${number(p.stars)} GitHub stars">☆ ${number(p.stars)}</span></div><div class="card-identity"><h3 class="card-name"><button data-project="${escape(p.id)}">${escape(p.name)}</button></h3><p class="card-author">${escape(p.author)}</p></div><p class="card-description">${escape(p.summary || t("前往项目仓库了解插件的使用方式。", "Read the repository to learn how this plugin works."))}</p><div class="card-footer"><span class="card-status ${tone}">${escape(label)}</span><span>${t("更新", "Updated")} ${shortDate(p.updatedAt)}</span><span class="card-arrow" aria-hidden="true">↗</span></div></article>`;
        })
        .join("")
    : `<div class="empty-state"><h3>${t("还没找到合适的结果", "No matching plugins yet")}</h3><p>${t("试试更短的关键词，或换一个分类。", "Try a shorter keyword or a different category.")}</p><button id="reset-search">${t("清除筛选", "Clear filters")}</button></div>`;
  $("#catalog-pagination").innerHTML =
    pages > 1
      ? `<button data-page="${state.page - 1}" ${state.page === 1 ? "disabled" : ""} aria-label="${t("上一页", "Previous page")}">←</button>${[
          ...new Set([
            1,
            ...Array.from({ length: 5 }, (_, i) => state.page + i - 2).filter(
              (n) => n > 1 && n < pages,
            ),
            pages,
          ]),
        ]
          .sort((a, b) => a - b)
          .map(
            (n, i, a) =>
              (i && n - a[i - 1] > 1 ? "<span>…</span>" : "") +
              `<button data-page="${n}" ${n === state.page ? 'aria-current="page"' : ""}>${n}</button>`,
          )
          .join(
            "",
          )}<button data-page="${state.page + 1}" ${state.page === pages ? "disabled" : ""} aria-label="${t("下一页", "Next page")}">→</button>`
      : "";
}
function openDialog() {
  lastOpener = document.activeElement;
  if (!$("#detail-dialog").open) $("#detail-dialog").showModal();
}
function renderDetail(p) {
  if (p.detailShard !== undefined && !p.detailLoaded) {
    $("#detail-content").innerHTML = `<h2 id="detail-title" class="detail-title">${escape(p.name)}</h2><p class="detail-summary">${p.detailError ? t("详细记录暂时无法读取。", "The detailed record could not load.") : t("正在读取最新探测记录…", "Loading the latest probe record…")}</p>${p.detailError ? `<button id="retry-detail">${t("重试", "Try again")}</button>` : ""}`;
    $("#retry-detail")?.addEventListener("click", () => loadDetail(p));
    return;
  }
  const probe = p.probe || {},
    [label] = status(p);
  const repository = `https://github.com/${encodeURIComponent(p.author)}/${encodeURIComponent(p.name)}`;
  const readme = `${repository}#readme`;
  const deps = (probe.dependencies || [])
    .map(
      (d) =>
        `<li><strong>${escape(d.name)}</strong><br>${t("声明", "Declared")}: <code>${escape(d.range)}</code> · ${d.reference === "runtime" ? t("当前 DSH 内置", "Bundled with DSH") : "npm latest"}: <code>${escape(d.latest || t("暂不可用", "Unavailable"))}</code><br>${d.matchesLatest === true ? t("版本范围包含当前发布版本", "Range includes current release") : d.matchesLatest === false ? t("版本范围不包含当前发布版本", "Range excludes current release") : t("无法自动判断版本范围", "Could not compare this version range")}</li>`,
    )
    .join("");
  $("#detail-content").innerHTML =
    `<p class="detail-eyebrow">${escape(p.author)} / ${escape(p.kind)} · ☆ ${number(p.stars)}</p><h2 class="detail-title" id="detail-title">${escape(p.name)}</h2><p class="detail-summary">${escape(p.summary || t("作者尚未提供简介。", "No description provided."))}</p><div class="detail-actions"><a href="${readme}" target="_blank" rel="noopener noreferrer">${t("查看使用说明", "Read documentation")} ↗</a><a href="${repository}" target="_blank" rel="noopener noreferrer">${t("项目源码", "Source code")} ↗</a><button id="share-project">${t("复制链接", "Copy link")}</button></div><section class="detail-section"><h3>${t("最新探测", "Latest probe")}</h3><dl class="detail-facts"><dt>${t("结果", "Result")}</dt><dd>${escape(label)}</dd><dt>${t("最近尝试", "Last attempt")}</dt><dd>${date(probe.attemptedAt)}</dd><dt>${t("成功读取", "Successful read")}</dt><dd>${date(probe.checkedAt)}</dd><dt>${t("项目更新", "Repository update")}</dt><dd>${date(p.updatedAt)}</dd><dt>${t("当前 DSH", "Current DSH")}</dt><dd>${escape(data.official.version)} · ${date(data.official.checkedAt)}</dd><dt>${t("插件版本", "Plugin version")}</dt><dd>${escape(probe.version || t("未声明", "Not declared"))}</dd><dt>${t("公开分支", "Public branch")}</dt><dd>${escape(probe.ref || p.branch)}</dd>${probe.entry ? `<dt>${t("入口文件", "Entry file")}</dt><dd>${escape(probe.entry)} · ${escape(probe.artifact || t("未检查", "Not checked"))}</dd>` : ""}</dl><p>${t("Hub 独立读取公开仓库的根目录 package.json 和声明的入口文件，优先与当前 DSH 实际内置版本对照；未内置的组件使用 npm latest，并逐项标明。版本差异不等于无法运行。此记录不代表安装或运行测试通过。", "Hub independently reads the root package.json and declared entry file, compares dependencies with versions bundled in current DSH, and labels npm latest fallbacks for components outside that graph. A range difference does not prove runtime incompatibility. This record does not represent a successful installation or runtime test.")}</p>${probe.lastObservation ? `<p>${t("本次读取失败。上一次成功观察：", "This attempt failed. Previous successful observation: ")}${date(probe.lastObservation.checkedAt)}</p>` : ""}</section><section class="detail-section"><h3>${t("依赖版本", "Dependency versions")}</h3>${deps ? `<ul class="dependency-list">${deps}</ul>` : `<p>${t("根目录清单中没有可比较的 DSH 依赖。请查阅仓库的安装说明。", "No comparable DSH dependencies were found in the root manifest. Check the repository installation instructions.")}</p>`}</section>`;
}
async function loadDetail(p) {
  const generation = data.generatedAt;
  p.detailError = false;
  if (activeProject === p) renderDetail(p);
  try {
    const response = await fetch(`market-details/${p.detailShard}.json`, { cache: "no-cache", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error("unavailable");
    const detail = await response.json();
    if (detail.generatedAt !== generation || !detail.projects[p.id]) throw Error("snapshot changed");
    Object.assign(p, detail.projects[p.id], { detailLoaded: true });
  } catch { p.detailError = true; }
  if (activeProject === p && $("#detail-dialog").open) renderDetail(p);
}
function openProject(id, writeHash = true) {
  const p = data?.projects.find((p) => p.id === id || p.aliases?.includes(id));
  if (!p) {
    if (data)
      toast(t("当前快照中未找到这个插件", "Plugin not found in this snapshot"));
    return;
  }
  activeProject = p;
  renderDetail(p);
  openDialog();
  if (!p.detailLoaded) loadDetail(p);
  if (writeHash)
    history.pushState(null, "", `#package=${encodeURIComponent(p.id)}`);
}
function renderSync() {
  $("#detail-content").innerHTML =
    `<span class="eyebrow">INDEPENDENT OBSERVATIONS</span><h2 id="detail-title" class="detail-title">${t("每条记录，都有时间", "Every record has a timestamp")}</h2><p class="detail-summary">${t("公开发现、文件探测与版本对照，由 Hub 自己完成。", "Public discovery, file probes and version comparisons are performed independently by Hub.")}</p><dl class="detail-facts"><dt>${t("快照生成", "Snapshot built")}</dt><dd>${date(data.generatedAt)}</dd><dt>${t("仓库发现", "Discovery")}</dt><dd>${date(data.discoveryAt)}</dd><dt>${t("收录项目", "Listed projects")}</dt><dd>${number(data.totals.listed)}</dd><dt>${t("成功探测", "Successful probes")}</dt><dd>${number(data.totals.probed)}</dd><dt>${t("当前 DSH", "Current DSH")}</dt><dd>${escape(data.official.version)}</dd><dt>${t("更新计划", "Schedule")}</dt><dd>${t("每 6 小时更新，24 小时内重新探测", "Refresh every 6 hours; re-probe within 24 hours")}</dd></dl><section class="detail-section"><p>${t("仓库代码变更或 DSH 版本发布会触发重新检查。读取失败会明确保留失败状态；记录过期时会显示待重新探测。根目录探测不覆盖所有 monorepo、技能目录或运行环境。", "Repository changes and new DSH releases trigger fresh checks. Failed reads remain visible; stale records are marked due. Root manifest probes do not cover every monorepo, skill directory or runtime environment.")}</p><a href="marketplace.json" target="_blank">${t("查看原始数据", "Read the data")} ↗</a></section><div class="detail-actions"><button id="refresh-data">${t("检查最新快照", "Check for a newer snapshot")}</button></div>`;
}
$("#sync-info").addEventListener("click", () => {
  if (!data) return;
  activeProject = null;
  renderSync();
  openDialog();
});
$("#detail-close").addEventListener("click", () => $("#detail-dialog").close());
$("#detail-dialog").addEventListener("click", (e) => {
  if (e.target === $("#detail-dialog")) {
    const r = e.target.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      e.target.close();
  }
});
$("#detail-dialog").addEventListener("close", () => {
  if (location.hash.startsWith("#package="))
    history.replaceState(
      null,
      "",
      location.pathname + location.search + "#catalog",
    );
  lastOpener?.focus({ preventScroll: true });
  activeProject = null;
});
$("#detail-content").addEventListener("click", async (e) => {
  if (e.target.closest("#share-project") && activeProject) {
    try {
      const url = new URL(location.href);
      url.hash = `package=${encodeURIComponent(activeProject.id)}`;
      await navigator.clipboard.writeText(url.href);
      toast(t("链接已复制", "Link copied"));
    } catch {
      toast(
        t(
          "复制失败，请复制地址栏链接",
          "Could not copy. Use the address bar link.",
        ),
      );
    }
  }
  if (e.target.closest("#refresh-data")) {
    const changed = await load();
    renderSync();
    toast(
      changed
        ? t("已读取最新快照", "Latest snapshot loaded")
        : t("暂时无法更新，请稍后重试", "Could not refresh. Try again later."),
    );
  }
});
function changed(scroll = false) {
  state.page = 1;
  updateURL();
  render();
  if (scroll)
    $("#catalog").scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
}
$("#market-search").value = state.query;
$("#sort").value = state.sort;
$("#confirmed-only").checked = state.confirmed;
$("#market-search").addEventListener("input", (e) => {
  state.query = e.target.value;
  changed();
});
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  changed(true);
});
$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  changed();
});
$("#confirmed-only").addEventListener("change", (e) => {
  state.confirmed = e.target.checked;
  changed();
});
$("#categories").addEventListener("click", (e) => {
  const b = e.target.closest("[data-category]");
  if (b) {
    state.category = b.dataset.category;
    changed();
  }
});
$$("[data-view]").forEach((b) =>
  b.addEventListener("click", () => {
    state.view = b.dataset.view;
    storage.set("hub-view", state.view);
    render();
  }),
);
$("#project-grid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-project]");
  if (b) openProject(b.dataset.project);
  if (e.target.closest("#reset-search")) {
    state.query = "";
    state.category = "all";
    state.confirmed = false;
    $("#market-search").value = "";
    $("#confirmed-only").checked = false;
    changed();
  }
});
$("#catalog-pagination").addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (b && !b.disabled) {
    state.page = Number(b.dataset.page);
    render();
    $("#catalog").scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }
});
document.addEventListener("keydown", (e) => {
  if (
    e.key === "/" &&
    !/input|textarea|select/i.test(e.target.tagName) &&
    !$("#detail-dialog").open
  ) {
    e.preventDefault();
    $("#market-search").focus();
  }
});
function followHash() {
  if (location.hash.startsWith("#package=")) {
    try {
      openProject(decodeURIComponent(location.hash.slice(9)), false);
    } catch {}
  } else if ($("#detail-dialog").open && activeProject)
    $("#detail-dialog").close();
}
window.addEventListener("hashchange", followHash);
window.addEventListener("popstate", () => {
  const p = new URLSearchParams(location.search);
  state.query = p.get("q") || "";
  state.category = p.get("category") || "all";
  state.sort = p.get("sort") || "stars";
  state.confirmed = p.get("evidence") === "1";
  $("#market-search").value = state.query;
  $("#sort").value = state.sort;
  $("#confirmed-only").checked = state.confirmed;
  state.page = 1;
  render();
  followHash();
});
async function load() {
  if (loading) return false;
  loading = true;
  try {
    const response = await fetch("market-index.json", {
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw Error("unavailable");
    const next = await response.json();
    if (
      next.schema !== "dsh-hub-market-index/v1" ||
      !Array.isArray(next.rows)
    )
      throw Error("invalid");
    next.projects = next.rows.map(row => {
      const p = Object.fromEntries(next.columns.map((key, i) => [key, row[i]]));
      [p.author, p.name] = p.id.split("/");
      return p;
    });
    data = next;
    render();
    return true;
  } catch {
    if (!data) {
      $("#project-grid").setAttribute("aria-busy", "false");
      $("#project-grid").innerHTML =
        `<div class="empty-state"><h3>${t("目录暂时无法加载", "The directory could not load")}</h3><p>${t("请检查网络后重试。", "Check your connection and try again.")}</p><button id="retry-load">${t("重新加载", "Try again")}</button></div>`;
      $("#result-count").textContent = t("加载失败", "Loading failed");
      $("#sync-label").textContent = t("快照暂不可用", "Snapshot unavailable");
      $("#retry-load").addEventListener("click", load);
    }
    return false;
  } finally {
    loading = false;
  }
}
localize();
await load();
followHash();
setInterval(
  () => {
    if (!document.hidden) load();
  },
  5 * 60 * 1000,
);
