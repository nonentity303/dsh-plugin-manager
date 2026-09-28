// namespace import：shell 的 react 是 CJS（module.exports = React，无 default），
// default 导入会被 esbuild 生成 .default 引用导致运行时崩溃（TabBoundary extends undefined）。
import * as React from "react";
const { useEffect, useMemo, useState, useSyncExternalStore } = React;

/**
 * 插件管理器 —— 浏览器端 v0.2（打包产物 lib/client.js 由客户端模块系统提供）。
 *
 * 界面：按必要程度折叠分组（必须/推荐/可选）、插件名称/简介、
 * 启用状态（红=错误·需检查 黄=需更新 灰=未启用 绿=启用）、
 * 更新按钮（从配置的更新源拉取）、更新源管理面板。
 */

const NS = "settings.pluginManagerPro";

const COLORS = {
	red: "#ef4444",
	yellow: "#f59e0b",
	green: "#22c55e",
	grey: "#9ca3af"
};

const STATUS_META = {
	error: { color: COLORS.red, key: "statusError" },
	update: { color: COLORS.yellow, key: "statusUpdate" },
	disabled: { color: COLORS.grey, key: "statusDisabled" },
	enabled: { color: COLORS.green, key: "statusEnabled" }
};

const NECESSITY_META = {
	core: { color: COLORS.red, key: "necessityCore" },
	recommended: { color: COLORS.yellow, key: "necessityRecommended" },
	optional: { color: COLORS.green, key: "necessityOptional" }
};

const NECESSITY_ORDER = ["core", "recommended", "optional"];

/**
 * 第三方配置槽位的「空源」：没有 provider（设置页 tab 上下文 / 单元测试）时，
 * useSyncExternalStore 仍需要一个稳定且恒等的 getSnapshot/subscribe 对。
 */
const EMPTY_CONFIG_SURFACES = Object.freeze({ rows: Object.freeze([]), bundles: Object.freeze([]) });
const EMPTY_CONFIG_SOURCE = Object.freeze({
	getSnapshot: () => EMPTY_CONFIG_SURFACES,
	subscribe: () => () => {}
});
const EMPTY_ITEMS = Object.freeze([]);
const EMPTY_ITEMS_SOURCE = Object.freeze({
	getSnapshot: () => EMPTY_ITEMS,
	subscribe: () => () => {}
});

/**
 * 把一个插件条目映射到它参与的第三方配置槽位键（0.1.7 契约）：
 * - `plugins.bundle.config` 的 key 就是**包名**（dshmarket → "dshmarket"）；
 * - `plugins.row.config` 的 key 是 `<包名>#<行id>`（free-search → "dsh-free-search#web-search-free"）。
 * 管理器快照只有 packageName / moduleName / configId、没有行 id，因此按前缀匹配：
 * 前缀命中三者之一即认为该行属于这个插件（同一个包注册多行时逐个列出）。
 *
 * 纯函数，test-render.mjs 可直接断言；未注册的键一律不产生出口。
 * @param entry 管理器条目（含 packageName/moduleName/configId）
 * @param surfaces 注册键快照 `{ rows: string[], bundles: string[] }`
 * @returns `{ rows: [{key, rowId}], bundles: [{key}] }`
 */
function configSurfacesFor(entry, surfaces) {
	if (entry === null || entry === undefined || surfaces === null || surfaces === undefined) {
		return { rows: [], bundles: [] };
	}
	const prefixes = [entry.packageName, entry.moduleName, entry.configId]
		.filter((value) => typeof value === "string" && value !== "")
		.map((value) => value.toLocaleLowerCase());
	if (prefixes.length === 0) return { rows: [], bundles: [] };
	const rows = [];
	for (const key of surfaces.rows ?? []) {
		if (typeof key !== "string") continue;
		const hash = key.lastIndexOf("#");
		if (hash <= 0) continue;
		if (!prefixes.includes(key.slice(0, hash).toLocaleLowerCase())) continue;
		rows.push({ key, rowId: key.slice(hash + 1) });
	}
	rows.sort((a, b) => a.key.localeCompare(b.key));
	const bundles = [];
	for (const key of surfaces.bundles ?? []) {
		if (typeof key !== "string" || key === "") continue;
		if (!prefixes.includes(key.toLocaleLowerCase())) continue;
		bundles.push({ key });
	}
	bundles.sort((a, b) => a.key.localeCompare(b.key));
	return { rows, bundles };
}

/** 状态优先：错误(红) > 需更新(黄) > 未启用(灰)/启用(绿)。 */
function statusOf(entry) {
	if (entry.phase === "failed" || entry.error) return "error";
	if (entry.needsUpdate === true) return "update";
	return entry.enabled ? "enabled" : "disabled";
}

function PluginManagerTab({ list, refresh, setEnabled, update, setSources, resetToggles, diagnose, quarantine, repairHarness, restartHarness, uninstallPackages, uninstallPreview, operationHistory, undoOperation, setSourceOverride, scenarioList, scenarioSave, scenarioUpdate, scenarioDelete, scenarioApply, getRescueConfig, setRescueConfig, getDownloadConfig, checkDownloads, updateBrowser, verifyProfile, fixProfile, marketCatalog, marketInstall, t, embedded = false, onlyUpdatable = false, renderSlot, configSurfaces }) {
	const [request, setRequest] = useState(0);
	const [onlyUpdatableSelf, setOnlyUpdatableSelf] = useState(false);
	const [query, setQuery] = useState("");
	const [originFilter, setOriginFilter] = useState("all");
	const [open, setOpen] = useState(new Set(["core"]));
	const [showSources, setShowSources] = useState(false);
	const [showRescue, setShowRescue] = useState(false);
	const [showMarket, setShowMarket] = useState(false);
	const [showScenarios, setShowScenarios] = useState(false);
	const [showHistory, setShowHistory] = useState(false);
	const [openConfig, setOpenConfig] = useState(null);
	const [uninstallTarget, setUninstallTarget] = useState(null);
	const [highlightCard, setHighlightCard] = useState(null);
	const [busy, setBusy] = useState(null);
	const [feedback, setFeedback] = useState(null);
	const [state, setState] = useState({ status: "loading" });

	// 第三方配置槽位的**已注册键**（响应式：槽位 ledger 变化即重渲染）。
	// renderSlot 由声明了 plugins.* children 的那条 main 注册（框架契约）提供；
	// 设置页 tab 那条注册没有 children → renderSlot 为 undefined → 此处全部降级为「无出口」。
	const surfaces = useSyncExternalStore(
		(configSurfaces ?? EMPTY_CONFIG_SOURCE).subscribe,
		(configSurfaces ?? EMPTY_CONFIG_SOURCE).getSnapshot,
		(configSurfaces ?? EMPTY_CONFIG_SOURCE).getSnapshot
	);
	const canRenderSurfaces = typeof renderSlot === "function";

	useEffect(() => {
		let current = true;
		setState({ status: "loading" });
		list().then((snapshot) => {
			if (current) setState({ status: "ready", snapshot });
		}, (error) => {
			if (current) setState({
				status: "error",
				message: error instanceof Error ? error.message : String(error)
			});
		});
		return () => {
			current = false;
		};
	}, [list, request]);

	const searching = query.trim() !== "";

	const sections = useMemo(() => {
		if (state.status !== "ready") return [];
		const normalized = query.trim().toLocaleLowerCase();
		const filtered = state.snapshot.entries.filter((entry) => {
			if ((onlyUpdatable || onlyUpdatableSelf) && !(entry.needsUpdate === true && entry.managed)) return false;
			if (originFilter !== "all" && entry.origin !== originFilter) return false;
			if (!normalized) return true;
			return entry.configId.toLocaleLowerCase().includes(normalized)
				|| entry.description.toLocaleLowerCase().includes(normalized)
				|| entry.moduleName.toLocaleLowerCase().includes(normalized);
		});
		return NECESSITY_ORDER.map((key) => ({
			key,
			entries: filtered.filter((entry) => entry.necessity === key)
		})).filter((section) => section.entries.length > 0);
	}, [query, originFilter, state.snapshot?.entries, onlyUpdatable, onlyUpdatableSelf]);

	/** 来源统计（chips 数量）。 */
	const originCounts = useMemo(() => {
		if (state.status !== "ready") return { builtin: 0, user: 0 };
		let builtin = 0;
		let user = 0;
		for (const entry of state.snapshot.entries) {
			if (entry.origin === "user") user += 1;
			else builtin += 1;
		}
		return { builtin, user };
	}, [state.snapshot?.entries]);

	/**
	 * 条目 -> 该条目参与的第三方配置槽位键（plugins.row.config / plugins.bundle.config）。
	 * 0.1.7 起第三方的配置界面**只**走这两个槽位（settings.plugin.item 已无声明者），
	 * 因此这里是「插件自带配置入口」的唯一来源；未注册的键不会产生按钮。
	 */
	const surfacesFor = useMemo(() => {
		const lookup = new Map();
		if (state.status !== "ready") return lookup;
		for (const entry of state.snapshot.entries) {
			const matched = configSurfacesFor(entry, surfaces);
			if (matched.rows.length > 0 || matched.bundles.length > 0) lookup.set(entry.entryId, matched);
		}
		return lookup;
	}, [surfaces, state.snapshot?.entries]);

	const updatable = useMemo(() => {
		if (state.status !== "ready") return [];
		return state.snapshot.entries.filter((entry) => entry.needsUpdate === true && entry.managed);
	}, [state.snapshot?.entries]);

	const restoreScroll = (scrollY) => {
		if (typeof requestAnimationFrame === "undefined" || typeof window === "undefined" || typeof window.scrollTo !== "function") return;
		requestAnimationFrame(() => window.scrollTo(0, scrollY));
	};

	const run = async (key, operation) => {
		// 保存滚动位置：防止 setState 触发的重渲染导致父容器滚动重置到右上角
		// 使用 typeof 检查确保非浏览器环境不崩溃（与文件内其他同类检查一致）
		const scrollY = typeof window !== "undefined" && typeof document !== "undefined"
			? window.scrollY ?? window.pageYOffset ?? document.documentElement?.scrollTop ?? 0
			: 0;
		setBusy(key);
		setFeedback(null);
		try {
			const result = await operation();
			// list/refresh/getSources/setSources 直接返回快照本体；setEnabled/update 返回
			// { ..., snapshot } 收据结构 —— 统一取快照。
			const snapshot = result?.snapshot ?? result;
			setState({ status: "ready", snapshot });
			// 恢复滚动位置（setState 批量更新，用 requestAnimationFrame 确保在 layout 之后）
			restoreScroll(scrollY);
			return result;
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
			restoreScroll(scrollY);
			return null;
		} finally {
			setBusy(null);
		}
	};

	const refreshAll = () => run("refresh", () => refresh());

	/** 来源人工修正：选择 auto=恢复自动判定，否则写入侧车持久化。 */
	const changeSource = (entry, value) => {
		const label = value === "auto" ? null : value;
		run(`source:${entry.packageName}`, () => setSourceOverride(entry.packageName, label)).then((snapshot) => {
			if (snapshot) setFeedback({ severity: "success", message: `${entry.packageName} 来源已保存。` });
		});
	};

	const toggle = (entry) => run(`entry:${entry.entryId}`, () => setEnabled(entry.entryId, !entry.enabled)).then((receipt) => {
		if (!receipt) return;
		const failed = receipt.items.filter((item) => item.status === "failed").map((item) => item.message).filter(Boolean).join(" ");
		const restart = receipt.items.filter((item) => item.status === "restart-required").map((item) => item.message).filter(Boolean).join(" ");
		if (failed) setFeedback({ severity: "error", message: failed });
		else if (restart) setFeedback({ severity: "warning", message: restart });
	});

	/** 触发浏览器原生下载（隐藏 iframe，交给浏览器下载进程 / NDM 扩展捕获）。 */
	const triggerBrowserDownload = (url) => {
		try {
			const iframe = document.createElement("iframe");
			iframe.style.display = "none";
			iframe.src = url;
			document.body.appendChild(iframe);
			setTimeout(() => {
				if (iframe.parentNode !== null) iframe.parentNode.removeChild(iframe);
			}, 60000);
			return true;
		} catch {
			return false;
		}
	};

	/** 轮询下载目录（浏览器/NDM 落盘后自动安装）。 */
	const pollDownloads = (durationMs = 120000) => new Promise((resolve) => {
		const started = Date.now();
		const timer = setInterval(async () => {
			try {
				const result = await checkDownloads();
				if ((result.installed ?? []).length > 0) {
					clearInterval(timer);
					resolve(result);
					return;
				}
			} catch {
				// 继续轮询
			}
			if (Date.now() - started > durationMs) {
				clearInterval(timer);
				resolve(null);
			}
		}, 5000);
	});

	/** 更新（默认：浏览器下载优先 → 落盘自动安装）。 */
	const updateOne = (entry) => run(`update:${entry.packageName}`, () => updateBrowser([entry.packageName])).then(async (receipt) => {
		if (!receipt || receipt.items.length === 0) return;
		const item = receipt.items[0];
		if (item.status === "need-download" && item.url) {
			setFeedback({ severity: "warning", message: `${item.packageName} → ${item.latestVersion}：已触发浏览器下载${item.url.startsWith("magnet:") ? "（P2P 磁力链接，浏览器可能无法直接处理，可用 NDM/比特彗星导入）" : ""}。下载完成后管理器自动安装（${t("dlDir")}：见救砖面板）。若浏览器未开始下载，请点击「内置下载」。` });
			triggerBrowserDownload(item.url);
			const result = await pollDownloads();
			if (result !== null) {
				setFeedback({ severity: "success", message: `${item.packageName}: ${t("dlInstalled")} ${result.installed.join(", ")}。重启 profile 后生效。` });
			}
			return;
		}
		if (item.status === "up-to-date") setFeedback({ severity: "success", message: `${item.packageName}: ${t("upToDate")}` });
		else if (item.status === "failed") setFeedback({ severity: "error", message: `${item.packageName}: ${item.message}` });
		else if (item.status === "not-managed") setFeedback({ severity: "warning", message: `${item.packageName}: ${item.message}` });
	});

	/** 更新（内置下载器兜底）。 */
	const updateOneInternal = (entry) => run(`update:${entry.packageName}`, () => update([entry.packageName])).then((receipt) => {
		if (!receipt || receipt.items.length === 0) return;
		const item = receipt.items[0];
		if (item.status === "updated") setFeedback({ severity: "success", message: `${item.packageName}: ${item.message}` });
		else if (item.status === "failed") setFeedback({ severity: "error", message: `${item.packageName}: ${item.message}` });
		else if (item.status === "not-managed") setFeedback({ severity: "warning", message: `${item.packageName}: ${item.message}` });
		else if (item.status === "up-to-date") setFeedback({ severity: "success", message: `${item.packageName}: ${t("upToDate")}` });
	});

	const updateAll = () => {
		if (updatable.length === 0) return;
		const names = updatable.map((entry) => entry.packageName);
		run("update:all", () => update(names)).then((receipt) => {
			if (!receipt) return;
			const updated = receipt.items.filter((item) => item.status === "updated").length;
			const failed = receipt.items.filter((item) => item.status === "failed").map((item) => `${item.packageName}: ${item.message}`).join(" ");
			const skipped = receipt.items.filter((item) => item.status !== "updated" && item.message).map((item) => `${item.packageName}: ${item.message}`).join("；");
			const parts = [];
			if (updated > 0) parts.push(`${updated} 个已更新`);
			if (skipped) parts.push(skipped);
			if (failed) setFeedback({ severity: "error", message: parts.join("；") });
			else setFeedback({ severity: "success", message: parts.join("；") });
		});
	};

	/** 一键还原：清空管理器写入的所有开关行（界面崩坏后的自救入口）。 */
	const resetAll = () => {
		if (!window.confirm(t("resetConfirm"))) return;
		run("reset", () => resetToggles()).then((snapshot) => {
			if (snapshot) setFeedback({ severity: "success", message: t("resetDone") });
		});
	};

	const saveSources = (sources) => run("sources", () => setSources(sources)).then((snapshot) => {
		if (snapshot) setFeedback({ severity: "success", message: t("sourcesSaved") });
		// host 保存后已在后台并行重检所有源；延迟 400ms 让"已保存"反馈先渲染，再刷新列表
		setTimeout(() => refreshAll(), 400);
	});

	const toggleSection = (key) => {
		setOpen((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const expandAll = () => setOpen(new Set(NECESSITY_ORDER));
	const collapseAll = () => setOpen(new Set());

	if (state.status === "loading") {
		return <p style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 13 }}>{t("loading")}</p>;
	}
	if (state.status === "error") {
		return (
			<div role="alert" style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--dsw-alias-state-error-primary)", fontSize: 13 }}>
				<span>{t("error")} <small>{state.message}</small></span>
				<button type="button" onClick={() => setRequest((value) => value + 1)} style={buttonStyle}>{t("retry")}</button>
			</div>
		);
	}

	const snapshot = state.snapshot;

	return (
		<section aria-label={t("title")} style={{ width: "100%", maxWidth: embedded ? "none" : 880, display: "flex", flexDirection: "column", gap: 10, color: "var(--dsw-alias-label-primary)" }}>
			<header style={{ display: "flex", justifyContent: embedded ? "flex-end" : "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
				{embedded ? null : (
				<div>
					<h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t("title")}</h3>
					<p style={{ margin: "2px 0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }}>
						{t("profile")}: <code style={{ fontFamily: "var(--ds-font-family-code)" }}>{snapshot.profileName}</code>
					</p>
				</div>
				)}
				<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
					{embedded ? null : (
					<>
					<button type="button" onClick={() => setShowMarket((v) => !v)} disabled={busy !== null}
						style={{ ...buttonStyle, color: "var(--dsw-alias-state-business-primary, #4f8cff)", borderColor: "var(--dsw-alias-state-business-primary, #4f8cff)", fontWeight: showMarket ? 600 : 400 }}>
						{t("market")}
					</button>
					<button type="button" onClick={() => setShowRescue((v) => !v)} disabled={busy !== null}
						style={{ ...buttonStyle, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)", fontWeight: showRescue ? 600 : 400 }}>
						{t("rescue")}
					</button>
					</>
					)}
					{embedded && updatable.length > 0 ? (
						<button type="button" onClick={() => setOnlyUpdatableSelf((v) => !v)}
							style={{ ...buttonStyle, fontWeight: onlyUpdatable || onlyUpdatableSelf ? 600 : 400 }}>
							{t("onlyUpdatable")} ({updatable.length})
						</button>
					) : null}
					<button type="button" onClick={resetAll} disabled={busy !== null}
						style={{ ...buttonStyle, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)" }}>
						{t("resetToggles")}
					</button>
					{updatable.length > 0 ? (
						<button type="button" onClick={updateAll} disabled={busy !== null}
							style={{ ...buttonStyle, background: "var(--dsw-alias-state-business-primary, #4f8cff)", color: "#fff", fontWeight: 600 }}>
							{t("updateAll")} ({updatable.length})
						</button>
					) : null}
					{embedded ? null : (
					<>
					<button type="button" onClick={() => setShowSources((v) => !v)} style={{ ...buttonStyle, fontWeight: showSources ? 600 : 400 }}>
						{t("sources")}
					</button>
					<button type="button" onClick={() => setShowScenarios((v) => !v)} disabled={busy !== null}
						style={{ ...buttonStyle, fontWeight: showScenarios ? 600 : 400 }}>
						{t("scenarios")}
					</button>
					<button type="button" onClick={() => setShowHistory((v) => !v)} disabled={busy !== null}
						style={{ ...buttonStyle, fontWeight: showHistory ? 600 : 400 }}>
						{t("history")}
					</button>
					</>
					)}
					<button type="button" aria-label={t("refresh")} title={t("refresh")} onClick={refreshAll} disabled={busy !== null} style={{ ...buttonStyle, width: 32, height: 32, display: "grid", placeItems: "center" }}>
						{busy === "refresh" ? "…" : "↻"}
					</button>
				</div>
			</header>

			{/* 图例 */}
			<div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>
				<span style={{ fontWeight: 600, marginRight: 2 }}>{t("legendNecessity")}:</span>
				{Object.entries(NECESSITY_META).map(([key, meta]) => (
					<span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
						<i style={{ width: 8, height: 8, borderRadius: 2, background: meta.color, display: "inline-block" }} />
						{t(meta.key)}
					</span>
				))}
				<span style={{ fontWeight: 600, margin: "0 2px 0 10px" }}>{t("legendStatus")}:</span>
				{Object.entries(STATUS_META).map(([key, meta]) => (
					<span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
						<i style={{ width: 8, height: 8, borderRadius: "50%", background: meta.color, display: "inline-block" }} />
						{t(meta.key)}
					</span>
				))}
				<span style={{ fontWeight: 600, margin: "0 2px 0 10px" }}>{t("legendOrigin")}:</span>
				<span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
					<i style={{ width: 8, height: 8, borderRadius: 2, background: "var(--dsw-alias-label-tertiary)", display: "inline-block" }} />
					{t("originBuiltin")}
				</span>
				<span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
					<i style={{ width: 8, height: 8, borderRadius: 2, background: "var(--dsw-alias-state-business-primary, #4f8cff)", display: "inline-block" }} />
					{t("originUser")}
				</span>
			</div>

			{/* 事务化卸载流程（行内「卸载」按钮触发：影响预览 → 确认 → 执行 → 报告） */}
			{uninstallTarget !== null ? (
				<UninstallFlow
					packageName={uninstallTarget}
					preview={uninstallPreview}
					uninstall={uninstallPackages}
					t={t}
					onDone={(changed) => {
						setUninstallTarget(null);
						if (changed) setRequest((value) => value + 1);
					}}
				/>
			) : null}

			{/* 更新源面板 */}
			{showSources ? <SourcesPanel sources={snapshot.sources} save={saveSources} busy={busy !== null} t={t} /> : null}

			{/* 插件市场（轻量：dshfind 精选目录 + 一键安装） */}
			{showMarket ? <MarketPanel marketCatalog={marketCatalog} marketInstall={marketInstall} busy={busy !== null} t={t} entries={state.status === "ready" ? state.snapshot.entries : []} /> : null}

			{/* 场景方案（保存/应用插件组合，切换前预览） */}
			{showScenarios ? <ScenarioPanel
				scenarioList={scenarioList}
				scenarioSave={scenarioSave}
				scenarioUpdate={scenarioUpdate}
				scenarioDelete={scenarioDelete}
				scenarioApply={scenarioApply}
				onSnapshot={(snapshot) => setState({ status: "ready", snapshot })}
				t={t}
			/> : null}

			{/* 操作历史（最近 20 次操作 + 一键撤销） */}
			{showHistory ? <HistoryPanel operationHistory={operationHistory} undoOperation={undoOperation} onSnapshot={(snapshot) => setState({ status: "ready", snapshot })} t={t} /> : null}

			{/* 救砖面板 */}
			{showRescue ? <RescuePanel
				diagnose={diagnose}
				quarantine={quarantine}
				repairHarness={repairHarness}
				restartHarness={restartHarness}
				uninstallPackages={uninstallPackages}
				uninstallPreview={uninstallPreview}
				getRescueConfig={getRescueConfig}
				setRescueConfig={setRescueConfig}
				getDownloadConfig={getDownloadConfig}
				checkDownloads={checkDownloads}
				verifyProfile={verifyProfile}
				fixProfile={fixProfile}
				// v0.8：所有用户安装包（含 file: vendor tgz）都支持事务化卸载
				managed={snapshot.entries.filter((entry) => entry.origin === "user")}
				t={t}
			/> : null}

			<label style={{ display: "flex", position: "relative", alignItems: "center" }}>
				<span style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>{t("search")}</span>
				<input
					type="search"
					value={query}
					placeholder={t("search")}
					onChange={(event) => setQuery(event.currentTarget.value)}
					style={{
						boxSizing: "border-box",
						width: "100%",
						height: 34,
						border: "1px solid var(--dsw-alias-border-l2)",
						background: "var(--dsw-alias-bg-layer-1)",
						color: "var(--dsw-alias-label-primary)",
						borderRadius: 7,
						padding: "0 12px",
						fontSize: 13,
						font: "inherit"
					}}
				/>
			</label>

			{/* 来源筛选：架构自带 vs 用户/agent 安装 */}
			<div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
				<span style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)", fontWeight: 600 }}>{t("originLegend")}:</span>
				<button type="button" onClick={() => setOriginFilter("all")}
					style={{ ...chipStyle, ...(originFilter === "all" ? chipOnStyle : null) }}>
					{t("originAll")} ({state.snapshot.entries.length})
				</button>
				<button type="button" onClick={() => setOriginFilter("builtin")}
					style={{ ...chipStyle, ...(originFilter === "builtin" ? chipOnStyle : null) }}>
					{t("originBuiltin")} ({originCounts.builtin})
				</button>
				<button type="button" onClick={() => setOriginFilter("user")}
					style={{ ...chipStyle, ...(originFilter === "user" ? chipOnStyle : null) }}>
					{t("originUser")} ({originCounts.user})
				</button>
			</div>

			{snapshot.entries.length === 0 ? <p style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 13 }}>{t("empty")}</p> : null}
			{snapshot.entries.length > 0 && sections.length === 0 ? <p style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 13 }}>{t("emptySearch")}</p> : null}

			{feedback ? (
				<p role={feedback.severity === "error" ? "alert" : "status"} style={{
					margin: 0,
					fontSize: 12,
					lineHeight: "18px",
					padding: "6px 10px",
					borderRadius: 6,
					background: feedback.severity === "error"
						? "color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)"
						: feedback.severity === "warning"
							? "color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 12%, transparent)"
							: "color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 12%, transparent)",
					color: feedback.severity === "error"
						? "var(--dsw-alias-state-error-primary)"
						: feedback.severity === "warning"
							? "var(--dsw-alias-state-warning-primary, #f59e0b)"
							: "var(--dsw-alias-state-success-primary, #22c55e)"
				}}>
					{feedback.message}
				</p>
			) : null}

			{/* 折叠分组（按必要程度） */}
			{sections.length > 1 ? (
				<div style={{ display: "flex", gap: 6, justifyContent: "flex-end", fontSize: 12 }}>
					<button type="button" onClick={expandAll} style={linkButtonStyle}>{t("expandAll")}</button>
					<button type="button" onClick={collapseAll} style={linkButtonStyle}>{t("collapseAll")}</button>
				</div>
			) : null}

			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				{sections.map((section) => {
					const meta = NECESSITY_META[section.key];
					const enabledCount = section.entries.filter((entry) => entry.enabled).length;
					const sectionUpdatable = section.entries.filter((entry) => entry.needsUpdate === true && entry.managed).length;
					const isOpen = searching || open.has(section.key);
					return (
						<section key={section.key} style={{
							border: "1px solid var(--dsw-alias-border-l2)",
							background: "var(--dsw-alias-bg-layer-3)",
							borderRadius: 8,
							overflow: "hidden"
						}}>
							<header style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: "pointer", userSelect: "none" }} onClick={() => toggleSection(section.key)}>
								<span aria-hidden="true" style={{
									width: 10,
									height: 10,
									borderRadius: 3,
									background: meta.color,
									flex: "none",
									transform: isOpen ? "rotate(90deg)" : "none",
									transition: "transform 120ms ease",
									clipPath: "polygon(0 0, 100% 50%, 0 100%)"
								}} />
								<span style={{ fontSize: 13, fontWeight: 600 }}>{t(meta.key)}</span>
								<span style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>
									{enabledCount}/{section.entries.length}
								</span>
								{sectionUpdatable > 0 ? (
									<span style={{
										fontSize: 11,
										padding: "1px 7px",
										borderRadius: 999,
										background: "color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 16%, transparent)",
										color: "var(--dsw-alias-state-warning-primary, #f59e0b)",
										fontWeight: 600
									}}>
										{t("updateAvailable")} {sectionUpdatable}
									</span>
								) : null}
								<span style={{ marginLeft: "auto", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>
									{isOpen ? "▾" : "▸"}
								</span>
							</header>
							{isOpen ? (
								<ul style={{ listStyle: "none", margin: 0, padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
									{section.entries.map((entry) => {
										const status = statusOf(entry);
										const statusMeta = STATUS_META[status];
										const running = busy === `entry:${entry.entryId}` || busy === `update:${entry.packageName}`;
										const updating = busy === `update:${entry.packageName}` || busy === "update:all";
										const canUpdate = entry.needsUpdate === true && entry.managed && !updating;
										// 第三方配置出口：只有**已注册**的键才产生按钮/出口（未注册 = 无按钮、不调用 renderSlot）
										const entrySurfaces = canRenderSurfaces ? surfacesFor.get(entry.entryId) : undefined;
										const rowSurface = entrySurfaces?.rows?.[0];
										const bundleSurface = entrySurfaces?.bundles?.[0];
										const rowPanelKey = rowSurface ? `row:${rowSurface.key}` : null;
										const bundlePanelKey = bundleSurface ? `bundle:${bundleSurface.key}` : null;
										const panelOpen = openConfig !== null && (openConfig === rowPanelKey || openConfig === bundlePanelKey);
										return (
											<li key={entry.entryId} style={{
												display: "block",
												padding: "8px 10px",
												border: "1px solid var(--dsw-alias-border-l2)",
												background: "var(--dsw-alias-bg-layer-1)",
												borderRadius: 8,
												minWidth: 0
											}}>
											<div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
												<span title={entry.error ?? undefined} style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none", width: 86, fontSize: 12, color: statusMeta.color }}>
													<i style={{ width: 9, height: 9, borderRadius: "50%", background: statusMeta.color, display: "inline-block", flex: "none" }} />
													{t(statusMeta.key)}
												</span>
												<div style={{ flex: "1 1 auto", minWidth: 0 }}>
													<div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
														<strong style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.configId}</strong>
														<span style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.moduleName}</span>
													</div>
													<p style={{ margin: "2px 0 0", color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px" }}>{entry.description}</p>
													{rowSurface ? (
														<div style={{ margin: "2px 0 0", fontSize: 11.5, lineHeight: "17px", color: "var(--dsw-alias-label-tertiary)" }}>
															{renderSlot("plugins.row.config", { view: "summary" }, { entryKey: rowSurface.key })}
														</div>
													) : null}
													{entry.installedVersion || entry.latestVersion ? (
														<p style={{ margin: "2px 0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 11, fontFamily: "var(--ds-font-family-code)" }}>
															{entry.installedVersion ?? "?"}{entry.latestVersion ? ` → ${entry.latestVersion}` : ""}
															{entry.updateSource ? ` (${entry.updateSource})` : ""}
															{entry.needsUpdate === null && entry.installedVersion ? ` (${t("versionUnknown")})` : ""}
														</p>
													) : null}
												</div>
												{entry.needsUpdate === true && !entry.managed ? (
													<span title={entry.moduleName} style={{ flex: "none", fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>{t("notManaged")}</span>
												) : null}
												{/* 右列两行：行1 = 用户安装 · 必要程度 · 启动开关；行2 = 更新源(来源选择) · 更新按键 · 锁 · 卸载（带外边框；架构自带不显示） */}
												<div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flex: "none" }}>
													<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap" }}>
														{entry.origin === "user" ? (
															<span title={t("originUserHint")} style={{
																flex: "none",
																fontSize: 11,
																padding: "2px 8px",
																borderRadius: 999,
																border: "1px solid var(--dsw-alias-state-business-primary, #4f8cff)",
																color: "var(--dsw-alias-state-business-primary, #4f8cff)",
																whiteSpace: "nowrap"
															}}>
																{t("originUser")}
															</span>
														) : null}
														<span style={{
															flex: "none",
															fontSize: 11,
															fontWeight: 600,
															padding: "2px 8px",
															borderRadius: 999,
															border: `1px solid ${NECESSITY_META[entry.necessity]?.color ?? COLORS.yellow}`,
															color: NECESSITY_META[entry.necessity]?.color ?? COLORS.yellow
														}}>
															{t(NECESSITY_META[entry.necessity]?.key ?? "necessityRecommended")}
														</span>
														{entry.archived ? (
															<span title={entry.protectionReason} style={{
																flex: "none",
																fontSize: 11,
																padding: "2px 8px",
																borderRadius: 999,
																border: "1px solid var(--dsw-alias-border-l2)",
																color: "var(--dsw-alias-label-tertiary)",
																whiteSpace: "nowrap"
															}}>
																{t("archived")}
															</span>
														) : null}
														<label
															title={entry.protected ? entry.protectionReason : `${entry.configId}: ${entry.enabled ? t("disableEntry") : t("enableEntry")}`}
															style={{
																flex: "none",
																display: "inline-flex",
																alignItems: "center",
																cursor: entry.protected || running ? "not-allowed" : "pointer",
																opacity: entry.protected ? 0.55 : 1
															}}
														>
															<input
																type="checkbox"
																checked={entry.enabled}
																disabled={entry.protected || running}
																aria-label={`${entry.configId}: ${entry.enabled ? t("disableEntry") : t("enableEntry")}`}
																onChange={() => toggle(entry)}
																style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
															/>
															<span aria-hidden="true" style={{
																position: "relative",
																width: 36,
																height: 20,
																borderRadius: 999,
																background: entry.enabled ? "var(--dsw-alias-state-business-primary, #4f8cff)" : "var(--dsw-alias-border-l2)",
																transition: "background 120ms ease"
															}}>
																<i style={{
																	position: "absolute",
																	top: 2,
																	left: entry.enabled ? 18 : 2,
																	width: 16,
																	height: 16,
																	borderRadius: "50%",
																	background: "#fff",
																	transition: "left 120ms ease"
																}} />
															</span>
															{running ? <span style={{ marginLeft: 6, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>…</span> : null}
														</label>
													</div>
													{entry.origin === "user" || entry.protected || rowSurface !== undefined || bundleSurface !== undefined ? (
														<div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
														{entry.origin === "user" ? (
															<label title={t("sourceOverrideHint")} style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10.5, color: "var(--dsw-alias-label-tertiary)" }}>
																<select
																	value={entry.sourceOverride ?? (entry.source ?? "npm")}
																	onChange={(e) => changeSource(entry, e.currentTarget.value)}
																	disabled={busy !== null}
																	aria-label={`${entry.configId}: ${t("sourceOverrideHint")}`}
																	style={{ fontSize: 10.5, borderRadius: 5, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-secondary)", padding: "1px 2px", maxWidth: 76, cursor: "pointer" }}
																>
																	<option value="auto">{t("sourceAuto")}</option>
																	<option value="npm">{t("sourceNpm")}</option>
																	<option value="github">{t("sourceGithub")}</option>
																	<option value="local">{t("sourceLocal")}</option>
																	<option value="builtin">{t("sourceBuiltin")}</option>
																</select>
															</label>
														) : null}
														{canUpdate ? (
															<>
																<button type="button" onClick={() => updateOne(entry)} disabled={busy !== null}
																	style={{ ...buttonStyle, flex: "none", fontWeight: 600, color: "var(--dsw-alias-state-warning-primary, #f59e0b)", borderColor: "var(--dsw-alias-state-warning-primary, #f59e0b)" }}>
																	{t("update")}
																</button>
																<button type="button" onClick={() => updateOneInternal(entry)} disabled={busy !== null}
																	title={t("updateInternalHint")}
																	style={{ ...buttonStyle, flex: "none", fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>
																	{t("updateInternal")}
																</button>
															</>
														) : null}
														{entry.protected ? (
															<span title={entry.protectionReason} style={{ flex: "none", fontSize: 12, opacity: 0.75, cursor: "help" }}>🔒</span>
														) : null}
														{entry.origin === "user" ? (
															<button type="button" onClick={() => setUninstallTarget(entry.packageName)} disabled={busy !== null}
																title={t("uninstallRowHint")}
																style={{ ...buttonStyle, flex: "none", fontWeight: 600, fontSize: 11, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)", whiteSpace: "nowrap" }}>
																{t("rescueUninstall")}
															</button>
														) : null}
														{/* 第三方自带配置入口：只有注册过的槽位键才有按钮（未注册 = 无按钮、不调用 renderSlot） */}
														{rowSurface ? (
															<button type="button" onClick={() => setOpenConfig(openConfig === rowPanelKey ? null : rowPanelKey)}
																title={`${t("configEntryHint")} · ${rowSurface.key}`}
																aria-expanded={openConfig === rowPanelKey}
																style={{ ...buttonStyle, flex: "none", fontWeight: 600, fontSize: 11, color: "var(--dsw-alias-state-business-primary, #4f8cff)", borderColor: "var(--dsw-alias-state-business-primary, #4f8cff)", whiteSpace: "nowrap" }}>
																⚙ {openConfig === rowPanelKey ? t("officialClose") : t("configEntry")}
															</button>
														) : null}
														{bundleSurface ? (
															<button type="button" onClick={() => setOpenConfig(openConfig === bundlePanelKey ? null : bundlePanelKey)}
																title={`${t("configEntryHint")} · ${bundleSurface.key}`}
																aria-expanded={openConfig === bundlePanelKey}
																style={{ ...buttonStyle, flex: "none", fontWeight: 600, fontSize: 11, color: "var(--dsw-alias-state-business-primary, #4f8cff)", borderColor: "var(--dsw-alias-state-business-primary, #4f8cff)", whiteSpace: "nowrap" }}>
																⚙ {openConfig === bundlePanelKey ? t("officialClose") : t("configBundleEntry")}
															</button>
														) : null}
														</div>
													) : null}
												</div>
											</div>
											{panelOpen ? (
												<div data-plugin-config-entry={openConfig} style={{
													marginTop: 8,
													border: "1px solid var(--dsw-alias-border-l2)",
													borderRadius: 8,
													padding: "10px 12px",
													background: "var(--dsw-alias-bg-layer-2)",
													minWidth: 0
												}}>
													{openConfig === rowPanelKey && rowSurface ? renderSlot("plugins.row.config", { view: "page" }, { entryKey: rowSurface.key }) : null}
													{openConfig === bundlePanelKey && bundleSurface ? renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: bundleSurface.key }) : null}
												</div>
											) : null}
											</li>
										);
									})}
								</ul>
							) : null}
						</section>
					);
				})}
			</div>
			{/*
			 * C3：旧槽位 `settings.plugin.item`（旧设置页的插件配置卡片）在 0.1.7 里
			 * **没有任何声明者**（全引擎搜索只有注释提到它），读它恒为空、卡片区/行内 ⚙ 永远不出现。
			 * 因此该路径已整体删除，第三方的配置入口改由上面的
			 * `plugins.row.config` / `plugins.bundle.config` 出口承担（0.1.7 仅存的配置槽位）。
			 */}
		</section>
	);
}

/** 组件级错误边界：渲染异常只影响本 tab，不拖垮整个设置页。 */
class TabBoundary extends React.Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error) {
		return { error };
	}
	render() {
		if (this.state.error !== null) {
			return (
				<p role="alert" style={{ color: "var(--dsw-alias-state-error-primary)", fontSize: 13, margin: 0 }}>
					插件管理器渲染出错：{String(this.state.error)}。请刷新页面后重试。
				</p>
			);
		}
		return this.props.children;
	}
}

/** 以错误边界包裹的 tab（注册进设置区的是这个组件）。 */
function SafeTab(props) {
	return React.createElement(TabBoundary, null, React.createElement(PluginManagerTab, props));
}

/** 救砖面板：诊断 → 隔离/卸载问题插件 → 修复/重启引擎 → 自动隔离配置 → 启动前自检 → 下载目录。 */
function RescuePanel({ diagnose, quarantine, repairHarness, restartHarness, uninstallPackages, uninstallPreview, getRescueConfig, setRescueConfig, getDownloadConfig, checkDownloads, verifyProfile, fixProfile, managed, t }) {
	const [issues, setIssues] = useState(null);
	const [busy, setBusy] = useState(false);
	const [feedback, setFeedback] = useState(null);
	const [auto, setAuto] = useState(false);
	const [dlDir, setDlDir] = useState(null);
	const [verify, setVerify] = useState(null);
	const [uninstallTarget, setUninstallTarget] = useState(null);

	useEffect(() => {
		let current = true;
		getRescueConfig().then((config) => {
			if (current) setAuto(config.autoQuarantine === true);
		}, () => {});
		getDownloadConfig().then((config) => {
			if (current) setDlDir(config.dir ?? null);
		}, () => {});
		runDiagnose();
		return () => {
			current = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const runDiagnose = async () => {
		setBusy(true);
		setFeedback(null);
		try {
			const result = await diagnose();
			setIssues(result.issues ?? []);
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(false);
		}
	};

	const runQuarantine = async (entryId) => {
		setBusy(true);
		try {
			const result = await quarantine([entryId]);
			const item = result.items?.[0];
			setFeedback({ severity: item?.status === "disabled" ? "success" : "warning", message: item ? `${item.status}${item.message ? `：${item.message}` : ""}` : "完成" });
			runDiagnose();
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(false);
		}
	};

	const runRepair = async () => {
		if (!window.confirm(t("rescueRepairConfirm"))) return;
		setBusy(true);
		try {
			const result = await repairHarness();
			const lines = (result.actions ?? []).map((a) => `· ${a.action}: ${a.detail}`).join("\n");
			setFeedback({ severity: "success", message: `${t("rescueRepairDone")}\n${lines}\n${t("rescueRestartHint")} ${result.restartCommand}` });
			runDiagnose();
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(false);
		}
	};

	const runRestart = async () => {
		if (!window.confirm(t("rescueRestartConfirm"))) return;
		try {
			const result = await restartHarness();
			setFeedback({ severity: "warning", message: result.message });
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		}
	};

	const runUninstall = async (packageName) => {
		// 事务化卸载：先展示影响预览（依赖/条目/开关行），用户确认后执行
		setUninstallTarget(packageName);
	};

	const saveAuto = async (enabled) => {
		setBusy(true);
		try {
			await setRescueConfig({ autoQuarantine: enabled });
			setAuto(enabled);
			setFeedback({ severity: "success", message: t("rescueAutoSaved") });
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(false);
		}
	};

	const runVerify = async () => {
		setBusy(true);
		try {
			const result = await verifyProfile();
			setVerify(result);
			setFeedback(result.ok
				? { severity: "success", message: t("verifyOk") }
				: { severity: "error", message: `${t("verifyBad")} ${(result.issues ?? []).map((i) => `${i.name}: ${i.reason}`).join("；")}` });
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(false);
		}
	};

	const runFixProfile = async () => {
		if (!window.confirm(t("fixProfileConfirm"))) return;
		setBusy(true);
		try {
			const result = await fixProfile();
			setFeedback({ severity: result.ok ? "success" : "error", message: `${result.message ?? ""} ${(result.actions ?? []).map((a) => `${a.action}: ${a.detail}`).join("；")}` });
			runVerify();
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(false);
		}
	};

	const runCheckDownloads = async () => {
		setBusy(true);
		try {
			const result = await checkDownloads();
			const parts = [];
			if ((result.installed ?? []).length > 0) parts.push(`${t("dlInstalled")} ${result.installed.join(", ")}`);
			if ((result.failed ?? []).length > 0) parts.push(`${t("dlFailed")} ${result.failed.map((f) => `${f.name}: ${f.message}`).join("；")}`);
			setFeedback({ severity: parts.length === 0 ? "success" : (result.failed?.length > 0 ? "warning" : "success"), message: parts.join("；") || t("dlEmpty") });
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div style={{
			border: "1px solid var(--dsw-alias-state-error-primary)",
			background: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent)",
			borderRadius: 8,
			padding: "10px 12px",
			display: "flex",
			flexDirection: "column",
			gap: 8
		}}>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
				<span style={{ fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-state-error-primary)" }}>🛟 {t("rescueTitle")}</span>
				<button type="button" onClick={runDiagnose} disabled={busy} style={buttonStyle}>{t("rescueDiagnose")}</button>
			</div>
			<p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: "18px" }}>{t("rescueHint")}</p>

			{uninstallTarget !== null ? (
				<UninstallFlow
					packageName={uninstallTarget}
					preview={uninstallPreview}
					uninstall={uninstallPackages}
					t={t}
					onDone={(changed) => {
						setUninstallTarget(null);
						if (changed) runDiagnose();
					}}
				/>
			) : null}

			{issues === null ? null : issues.length === 0 ? (
				<p className="ok-note" style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-state-success-primary, #22c55e)" }}>{t("rescueClean")}</p>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					{issues.map((issue) => (
						<div key={issue.entryId} style={{ border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", borderRadius: 8, padding: "8px 10px" }}>
							<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
								<b style={{ fontSize: 13, color: "var(--dsw-alias-state-error-primary)" }}>{issue.configId}</b>
								<span style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>{issue.moduleName} · {issue.phase}</span>
								<span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
									{issue.suggestion === "disable" ? (
										<button type="button" onClick={() => runQuarantine(issue.entryId)} disabled={busy}
											style={{ ...buttonStyle, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)" }}>
											{t("rescueDisable")}
										</button>
									) : <span style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>{t("rescueProtected")}</span>}
									{issue.canUninstall ? (
										<button type="button" onClick={() => runUninstall(issue.moduleName)} disabled={busy} style={buttonStyle}>{t("rescueUninstall")}</button>
									) : null}
								</span>
							</div>
							{issue.error ? <pre style={{ margin: "6px 0 0", fontSize: 11, color: "var(--dsw-alias-label-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 80, overflow: "auto" }}>{issue.error}</pre> : null}
						</div>
					))}
				</div>
			)}

			<div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
				<button type="button" onClick={runRepair} disabled={busy} style={{ ...buttonStyle, background: "var(--dsw-alias-state-error-primary)", color: "#fff", fontWeight: 600 }}>{t("rescueRepair")}</button>
				<button type="button" onClick={runRestart} disabled={busy} style={{ ...buttonStyle, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)" }}>{t("rescueRestart")}</button>
				<label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer", marginLeft: 8 }}>
					<input type="checkbox" checked={auto} disabled={busy} onChange={(e) => saveAuto(e.currentTarget.checked)} />
					{t("rescueAuto")}
				</label>
			</div>

			{/* 启动前自检（坏 bundle 会让引擎起不来 —— 自动化救砖） */}
			<div style={{ borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
					<span style={{ fontSize: 12, fontWeight: 600 }}>{t("verifyTitle")}</span>
					<button type="button" onClick={runVerify} disabled={busy} style={buttonStyle}>{t("verifyRun")}</button>
					<button type="button" onClick={runFixProfile} disabled={busy} style={{ ...buttonStyle, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)" }}>{t("fixProfile")}</button>
				</div>
				{verify !== null && !verify.ok ? (
					<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
						{(verify.issues ?? []).map((issue, i) => (
							<p key={i} style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }}>
								⚠ {issue.name}: {issue.reason}
							</p>
						))}
					</div>
				) : null}
				<p style={{ margin: 0, fontSize: 11, color: "var(--dsw-alias-label-tertiary)", lineHeight: "16px" }}>{t("verifyHint")}</p>
			</div>

			{/* 下载目录（浏览器/NDM/aria2 下载到该目录后自动安装） */}
			<div style={{ borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
					<span style={{ fontSize: 12, fontWeight: 600 }}>{t("dlTitle")}</span>
					<button type="button" onClick={runCheckDownloads} disabled={busy} style={buttonStyle}>{t("dlCheck")}</button>
				</div>
				<p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary)" }}>
					{t("dlDir")}: <code style={{ fontFamily: "var(--ds-font-family-code)", fontSize: 11 }}>{dlDir ?? "…"}</code>
				</p>
				<p style={{ margin: 0, fontSize: 11, color: "var(--dsw-alias-label-tertiary)", lineHeight: "16px" }}>{t("dlHint")}</p>
			</div>

			{managed.length > 0 ? (
				<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
					<span style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("rescueUninstallList")}</span>
					<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
						{managed.map((entry) => (
							<span key={entry.packageName} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 999, padding: "2px 8px", fontSize: 11 }}>
								{entry.configId}
								<button type="button" onClick={() => runUninstall(entry.packageName)} disabled={busy} style={linkButtonStyle}>{t("rescueUninstall")}</button>
							</span>
						))}
					</div>
				</div>
			) : null}

			{feedback ? (
				<p role="alert" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", color: feedback.severity === "error" ? "var(--dsw-alias-state-error-primary)" : feedback.severity === "warning" ? "var(--dsw-alias-state-warning-primary, #f59e0b)" : "var(--dsw-alias-state-success-primary, #22c55e)" }}>{feedback.message}</p>
			) : null}
		</div>
	);
}

/** 事务化卸载流程：影响预览 → 确认（可选级联） → 执行 → 卸载报告（自主校验 + 残留）。 */
function UninstallFlow({ packageName, preview, uninstall, t, onDone }) {
	const [data, setData] = useState(null);
	const [loadError, setLoadError] = useState(null);
	const [cascade, setCascade] = useState(false);
	const [busy, setBusy] = useState(false);
	const [report, setReport] = useState(null);

	useEffect(() => {
		let current = true;
		preview([packageName]).then((result) => {
			if (current) setData(result.packages?.[0] ?? null);
		}, (error) => {
			if (current) setLoadError(error instanceof Error ? error.message : String(error));
		});
		return () => {
			current = false;
		};
	}, [preview, packageName]);

	const doUninstall = async () => {
		setBusy(true);
		setReport(null);
		try {
			const result = await uninstall([packageName], { cascade });
			setReport(result.items?.[0] ?? null);
		} catch (error) {
			setReport({ status: "failed", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div style={{ border: "1px solid var(--dsw-alias-state-warning-primary, #f59e0b)", background: "color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 8%, transparent)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
				<span style={{ fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-state-warning-primary, #f59e0b)" }}>{t("uninstallTitle")}: {packageName}</span>
				<button type="button" onClick={() => onDone(false)} disabled={busy} style={linkButtonStyle}>{t("cancel")}</button>
			</div>
			{loadError ? <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }}>{t("uninstallPreviewFail")}: {loadError}</p> : null}
			{data === null && !loadError ? <p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("uninstallPreviewLoading")}</p> : null}
			{data !== null && !report ? (
				<>
					{!data.canUninstall ? (
						<p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }}>{data.spec === null ? t("uninstallNotManaged") : t("uninstallLocalBlocked")}</p>
					) : (
						<>
							<p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary)", lineHeight: "18px" }}>{t("uninstallPreviewHint")}</p>
							<div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
								{data.affectedEntries.length > 0 ? (
									<p style={{ margin: 0 }}>
										{t("uninstallAffectedEntries")}: <code style={{ fontFamily: "var(--ds-font-family-code)", fontSize: 11 }}>{data.affectedEntries.map((e) => e.configId).join(", ")}</code>
									</p>
								) : (
									<p style={{ margin: 0, color: "var(--dsw-alias-label-tertiary)" }}>{t("uninstallNoEntries")}</p>
								)}
								{data.inBundles ? <p style={{ margin: 0 }}>{t("uninstallBundleRow")}</p> : null}
								{data.patchRows > 0 ? <p style={{ margin: 0 }}>{t("uninstallPatchRows")}: {data.patchRows}</p> : null}
								{data.dependents.length > 0 ? (
									<div style={{ border: "1px solid var(--dsw-alias-state-warning-primary, #f59e0b)", borderRadius: 6, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
										<p style={{ margin: 0, fontWeight: 600, color: "var(--dsw-alias-state-warning-primary, #f59e0b)" }}>⚠ {t("uninstallDependents")}:</p>
										{data.dependents.map((d, i) => (
											<p key={i} style={{ margin: 0, fontSize: 11.5 }}>
												<code style={{ fontFamily: "var(--ds-font-family-code)", fontSize: 11 }}>{d.packageName}</code>
												<span style={{ color: "var(--dsw-alias-label-tertiary)" }}> ({d.type}: {d.spec})</span>
											</p>
										))}
										<label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer" }}>
											<input type="checkbox" checked={cascade} disabled={busy} onChange={(e) => setCascade(e.currentTarget.checked)} />
											{t("uninstallCascade")}（{data.dependents.filter((d) => true).length}）
										</label>
									</div>
								) : null}
							</div>
							<div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
								<button type="button" onClick={doUninstall} disabled={busy}
									style={{ ...buttonStyle, background: "var(--dsw-alias-state-error-primary)", color: "#fff", fontWeight: 600 }}>
									{busy ? t("uninstalling") : t("uninstallConfirm")}
								</button>
							</div>
						</>
					)}
				</>
			) : null}
			{report !== null ? (
				<div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
					<p style={{ margin: 0, color: report.status === "removed" ? "var(--dsw-alias-state-success-primary, #22c55e)" : "var(--dsw-alias-state-error-primary)" }}>
						{report.status === "removed" ? "✓ " : report.status === "rolled-back" ? "↩ " : "✗ "}
						{t(`uninstallStatus${report.status}`)}: {report.message}
					</p>
					{report.status === "removed" ? (
						<>
							{report.verifyOk === true ? <p style={{ margin: 0, color: "var(--dsw-alias-state-success-primary, #22c55e)" }}>✓ {t("uninstallVerifyOk")}</p> : null}
							{report.removedPatchRows > 0 ? <p style={{ margin: 0 }}>{t("uninstallReportRows")}: {report.removedPatchRows}</p> : null}
							{report.dependentPackages.length > 0 ? <p style={{ margin: 0 }}>{t("uninstallReportCascade")}: {report.dependentPackages.join(", ")}</p> : null}
							{report.residuals.length > 0 ? <p style={{ margin: 0, color: "var(--dsw-alias-state-warning-primary, #f59e0b)" }}>{t("uninstallResiduals")}: {report.residuals.join(", ")}</p> : null}
						</>
					) : null}
					<div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
						<button type="button" onClick={() => onDone(report.status === "removed")} style={buttonStyle}>{t("done")}</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

/** 操作历史：最近 20 次操作，支持一键撤销。 */
function HistoryPanel({ operationHistory, undoOperation, onSnapshot, t }) {
	const [operations, setOperations] = useState(null);
	const [busy, setBusy] = useState(null);
	const [feedback, setFeedback] = useState(null);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		let current = true;
		operationHistory().then((result) => {
			if (current) setOperations(result.operations ?? []);
		}, (error) => {
			if (current) setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		});
		return () => {
			current = false;
		};
	}, [operationHistory, tick]);

	const doUndo = async (id) => {
		setBusy(id);
		setFeedback(null);
		try {
			const result = await undoOperation(id);
			setFeedback({ severity: result.ok ? "success" : "warning", message: result.message });
			if (result.snapshot) onSnapshot(result.snapshot);
			setTick((v) => v + 1);
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(null);
		}
	};

	return (
		<div style={{ border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<span style={{ fontSize: 13, fontWeight: 600 }}>{t("historyTitle")}</span>
				<span style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>{t("historyHint")}</span>
				<button type="button" onClick={() => setTick((v) => v + 1)} disabled={busy !== null} style={linkButtonStyle}>{t("refresh")}</button>
			</div>
			{feedback ? <p role="alert" style={{ margin: 0, fontSize: 12, color: feedback.severity === "error" ? "var(--dsw-alias-state-error-primary)" : feedback.severity === "warning" ? "var(--dsw-alias-state-warning-primary, #f59e0b)" : "var(--dsw-alias-state-success-primary, #22c55e)" }}>{feedback.message}</p> : null}
			{operations === null ? <p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("loading")}</p> : operations.length === 0 ? (
				<p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("historyEmpty")}</p>
			) : (
				<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflow: "auto" }}>
					{operations.map((op) => (
						<li key={op.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", borderRadius: 6, padding: "6px 8px" }}>
							<span style={{ flex: "1 1 auto", minWidth: 0 }}>
								<span style={{ fontWeight: 600 }}>{op.label}</span>
								{op.detail ? <span style={{ color: "var(--dsw-alias-label-tertiary)", marginLeft: 6 }}>{op.detail}</span> : null}
								<span style={{ display: "block", fontSize: 10.5, color: "var(--dsw-alias-label-tertiary)" }}>
									{op.at.slice(0, 16).replace("T", " ")} · {op.action}{op.undone ? ` · ${t("historyUndone")}` : ""}
								</span>
							</span>
							{op.undo && !op.undone ? (
								<button type="button" onClick={() => doUndo(op.id)} disabled={busy !== null}
									style={{ ...buttonStyle, flex: "none", color: "var(--dsw-alias-state-business-primary, #4f8cff)", borderColor: "var(--dsw-alias-state-business-primary, #4f8cff)" }}>
									{busy === op.id ? "…" : t("historyUndo")}
								</button>
							) : null}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** 场景方案：保存当前插件组合为命名场景，一键应用（应用前展示变更预览）。 */
function ScenarioPanel({ scenarioList, scenarioSave, scenarioUpdate, scenarioDelete, scenarioApply, onSnapshot, t }) {
	const [scenarios, setScenarios] = useState(null);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(null);
	const [feedback, setFeedback] = useState(null);
	const [preview, setPreview] = useState(null);
	const [previewFor, setPreviewFor] = useState(null);
	const [applying, setApplying] = useState(null);

	const reload = () => scenarioList().then((result) => setScenarios(result.scenarios ?? []), (error) => setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) }));

	useEffect(() => {
		reload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const doSave = async () => {
		setBusy("save");
		setFeedback(null);
		try {
			const result = await scenarioSave(name.trim());
			setScenarios(result.scenarios ?? []);
			setName("");
			setFeedback({ severity: "success", message: t("scenarioSaved") });
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(null);
		}
	};

	const applyPreview = async (scenario) => {
		setBusy(`preview:${scenario.id}`);
		setFeedback(null);
		setPreviewFor(scenario.id);
		try {
			const result = await scenarioApply(scenario.id, true);
			const changed = (result.items ?? []).filter((i) => i.changed);
			setPreview(changed.length > 0 ? { scenario: result.scenarios?.find((s) => s.id === scenario.id) ?? scenario, items: changed } : null);
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(null);
		}
	};

	const doApply = async (scenario) => {
		setApplying(scenario.id);
		setFeedback(null);
		try {
			const result = await scenarioApply(scenario.id, false);
			const changed = (result.items ?? []).filter((i) => i.status === "changed").length;
			const skipped = (result.items ?? []).filter((i) => i.status === "skipped").length;
			setScenarios(result.scenarios ?? []);
			if (result.snapshot) onSnapshot(result.snapshot);
			setPreview(null);
			setPreviewFor(null);
			setFeedback({ severity: changed > 0 ? "success" : "warning", message: `${t("scenarioApplied")}：${changed} 项切换${skipped > 0 ? `，${skipped} 项被保护跳过` : ""}。${changed > 0 ? t("restartHint") : ""}` });
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setApplying(null);
		}
	};

	const doDelete = async (scenario) => {
		if (!window.confirm(`${t("scenarioDeleteConfirm")} ${scenario.name}？`)) return;
		setBusy(`delete:${scenario.id}`);
		try {
			const result = await scenarioDelete(scenario.id);
			setScenarios(result.scenarios ?? []);
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(null);
		}
	};

	return (
		<div style={{ border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<span style={{ fontSize: 13, fontWeight: 600 }}>{t("scenarioTitle")}</span>
				<span style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>{t("scenarioHint")}</span>
			</div>
			<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
				<input value={name} placeholder={t("scenarioName")} onChange={(e) => setName(e.currentTarget.value)} style={{ ...inputStyle, flex: "1 1 160px" }} />
				<button type="button" onClick={doSave} disabled={busy !== null || name.trim() === ""} style={buttonStyle}>{t("scenarioSave")}</button>
			</div>
			{feedback ? <p role="alert" style={{ margin: 0, fontSize: 12, color: feedback.severity === "error" ? "var(--dsw-alias-state-error-primary)" : feedback.severity === "warning" ? "var(--dsw-alias-state-warning-primary, #f59e0b)" : "var(--dsw-alias-state-success-primary, #22c55e)" }}>{feedback.message}</p> : null}
			{scenarios === null ? <p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("loading")}</p> : scenarios.length === 0 ? (
				<p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("scenarioEmpty")}</p>
			) : (
				<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
					{scenarios.map((scenario) => (
						<li key={scenario.id} style={{ border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", borderRadius: 8, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
								<b style={{ fontSize: 13 }}>{scenario.name}</b>
								<span style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>
									{t("scenarioCounts")}: {scenario.counts?.enabled ?? 0}/{scenario.counts?.disabled ?? 0} · {scenario.updatedAt.slice(0, 10)}
								</span>
								<span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
									{previewFor === scenario.id && preview === null && busy === `preview:${scenario.id}` ? (
										<span style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>{t("scenarioCalculating")}</span>
									) : (
										<button type="button" onClick={() => applyPreview(scenario)} disabled={busy !== null} style={buttonStyle}>{t("scenarioApply")}</button>
									)}
									<button type="button" onClick={() => scenarioUpdate(scenario.id).then((r) => setScenarios(r.scenarios ?? [])).catch((e) => setFeedback({ severity: "error", message: e.message }))} disabled={busy !== null}
										title={t("scenarioUpdateHint")} style={buttonStyle}>{t("scenarioUpdate")}</button>
									<button type="button" onClick={() => doDelete(scenario)} disabled={busy !== null} style={{ ...buttonStyle, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)" }}>{t("scenarioDelete")}</button>
								</span>
							</div>
							{previewFor === scenario.id && preview !== null ? (
								<div style={{ border: "1px dashed var(--dsw-alias-state-warning-primary, #f59e0b)", borderRadius: 6, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
									<p style={{ margin: 0, fontSize: 11.5, fontWeight: 600, color: "var(--dsw-alias-state-warning-primary, #f59e0b)" }}>{t("scenarioPreviewTitle")}</p>
									{preview.items.map((item) => (
										<p key={item.configId} style={{ margin: 0, fontSize: 11.5 }}>
											<code style={{ fontFamily: "var(--ds-font-family-code)", fontSize: 11 }}>{item.configId}</code>
											{" "}{item.current ? t("statusEnabled") : t("statusDisabled")} → {item.enabled ? t("statusEnabled") : t("statusDisabled")}
											{item.protected ? <span style={{ color: "var(--dsw-alias-label-tertiary)", marginLeft: 6 }}>🔒 {item.reason ?? ""}</span> : null}
										</p>
									))}
									<div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
										<button type="button" onClick={() => doApply(scenario)} disabled={applying !== null}
											// 填充式警告按钮：0.1.7 没有 warning 的「填充色」令牌，用更深的琥珀兜底，
										// 保证白字对比度（#b45309 on #fff ≈ 5.0:1），否则会退化成白字透明底
										style={{ ...buttonStyle, background: "var(--dsw-alias-state-warning-primary, #b45309)", color: "#fff", fontWeight: 600 }}>
											{applying === scenario.id ? t("scenarioApplying") : t("scenarioApplyConfirm")}
										</button>
										<button type="button" onClick={() => { setPreview(null); setPreviewFor(null); }} disabled={applying !== null} style={buttonStyle}>{t("cancel")}</button>
									</div>
								</div>
							) : null}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** 市场目录模块级缓存：切换面板/重进设置页时秒开，挂载时后台刷新。 */
let marketCatalogCache = null;

const MARKET_PAGE_SIZE = 20;

/** 面板语言（zh / en，用于本地化描述与分类名）。 */
function marketLang() {
	try {
		const nav = typeof window !== "undefined" && window.navigator ? window.navigator : null;
		return ((nav && (nav.language || nav.userLanguage)) || "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
	} catch {
		return "zh";
	}
}

/** 条目是否已安装：npm 包名 / 目录名 / 仓库名 任一命中 profile 依赖或本次会话刚装。 */
function entryInstalled(item, installedNames, justInstalled) {
	if (justInstalled.has(item.name)) return true;
	if (typeof item.npm === "string" && (installedNames.has(item.npm) || justInstalled.has(item.npm))) return true;
	if (installedNames.has(item.name)) return true;
	const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/.+)?\/?$/.exec(item.url || "");
	if (repo !== null && installedNames.has(repo[1].split("/")[1])) return true;
	return false;
}

/** 纯函数：目录过滤（分类/搜索：名称/仓库/npm/全部语言描述）+ 排序（stars/收录时间）。测试直接调用。 */
function marketFilterItems(catalog, query, category, sortBy) {
	if (!catalog) return [];
	const q = query.trim().toLocaleLowerCase();
	const filtered = catalog.items.filter((item) => {
		if (category !== "all" && item.category !== category) return false;
		if (!q) return true;
		if (item.name.toLocaleLowerCase().includes(q)) return true;
		if (item.owner.toLocaleLowerCase().includes(q)) return true;
		if (typeof item.npm === "string" && item.npm.toLocaleLowerCase().includes(q)) return true;
		const desc = item.description ? Object.values(item.description).filter(Boolean).join(" ") : "";
		return desc.toLocaleLowerCase().includes(q);
	});
	return [...filtered].sort((a, b) => {
		if (sortBy === "added") return String(b.added || "").localeCompare(String(a.added || ""));
		return (b.stars ?? -1) - (a.stars ?? -1);
	});
}

/** 插件市场面板：dshfind 精选目录一次拉全量，搜索/分类/排序/分页全部本地瞬时完成。 */
function MarketPanel({ marketCatalog, marketInstall, busy, t, entries }) {
	const [catalog, setCatalog] = useState(marketCatalogCache);
	const [loadError, setLoadError] = useState(null);
	const [reloadTick, setReloadTick] = useState(0);
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState("all");
	const [sortBy, setSortBy] = useState("stars");
	const [page, setPage] = useState(1);
	const [confirmEntry, setConfirmEntry] = useState(null);
	const [installing, setInstalling] = useState(null);
	const [justInstalled, setJustInstalled] = useState(() => new Set());
	const [feedback, setFeedback] = useState(null);

	const lang = marketLang();
	const installedNames = useMemo(() => {
		const names = new Set();
		for (const entry of entries || []) {
			if (entry.packageName) names.add(entry.packageName);
		}
		return names;
	}, [entries]);

	// 拉取目录（模块缓存命中则直接渲染，仍以远程为准）
	useEffect(() => {
		let current = true;
		if (marketCatalogCache !== null) return;
		marketCatalog().then((result) => {
			if (!current) return;
			marketCatalogCache = result;
			setCatalog(result);
			setLoadError(null);
		}, (error) => {
			if (current) setLoadError(error instanceof Error ? error.message : String(error));
		});
		return () => {
			current = false;
		};
	}, [marketCatalog, reloadTick]);

	const visible = useMemo(() => marketFilterItems(catalog, query, category, sortBy), [catalog, query, category, sortBy]);

	useEffect(() => {
		setPage(1);
	}, [query, category, sortBy]);

	const shown = visible.slice(0, page * MARKET_PAGE_SIZE);
	const hasMore = shown.length < visible.length;

	const refreshCatalog = () => {
		marketCatalogCache = null;
		setCatalog(null);
		setLoadError(null);
		setReloadTick((v) => v + 1);
	};

	const install = async (item) => {
		setInstalling(item.name);
		setFeedback(null);
		try {
			const result = await marketInstall({ name: item.name, npm: item.npm, url: item.url }, false);
			const severity = result.status === "installed" ? "success" : result.status === "already-installed" ? "warning" : "error";
			setFeedback({ severity, message: result.message ?? result.status });
			if (result.status === "installed") {
				setJustInstalled((prev) => {
					const next = new Set(prev);
					next.add(result.packageName ?? item.name);
					next.add(item.name);
					return next;
				});
				setConfirmEntry(null);
			}
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setInstalling(null);
		}
	};

	const cats = catalog?.categories ? Object.keys(catalog.categories) : [];
	const catLabel = (id) => {
		const meta = catalog?.categories?.[id];
		return meta ? meta[lang] || meta.en || id : id;
	};
	const sourceLabel = {
		live: t("marketSourceLive"),
		cache: t("marketSourceCache"),
		"github-fallback": t("marketSourceFallback"),
		error: t("marketSourceError")
	}[catalog?.source] ?? catalog?.source;

	return (
		<div style={{
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			borderRadius: 8,
			padding: "10px 12px",
			display: "flex",
			flexDirection: "column",
			gap: 8
		}}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
				<span style={{ fontSize: 13, fontWeight: 600 }}>{t("marketTitle")}</span>
				{catalog ? (
					<span className="muted" style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }} title={catalog.updated ?? ""}>
						{sourceLabel} · {catalog.count} {t("marketPlugins")}
						{catalog.updated ? ` · ${t("marketUpdated")} ${catalog.updated.slice(0, 10)}` : ""}
					</span>
				) : null}
				<input
					type="search"
					value={query}
					placeholder={t("marketSearch")}
					onChange={(e) => setQuery(e.currentTarget.value)}
					style={{
						boxSizing: "border-box",
						flex: "1 1 200px",
						height: 30,
						border: "1px solid var(--dsw-alias-border-l2)",
						background: "var(--dsw-alias-bg-layer-1)",
						color: "var(--dsw-alias-label-primary)",
						borderRadius: 6,
						padding: "0 10px",
						fontSize: 12,
						font: "inherit"
					}}
				/>
				<select
					value={sortBy}
					onChange={(e) => setSortBy(e.currentTarget.value)}
					style={{ height: 30, fontSize: 12, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)" }}
					aria-label={t("marketSort")}
				>
					<option value="stars">{t("marketSortStars")}</option>
					<option value="added">{t("marketSortAdded")}</option>
				</select>
				<button type="button" onClick={refreshCatalog} disabled={busy} title={t("marketRefresh")} style={{ ...buttonStyle, width: 30, height: 30, display: "grid", placeItems: "center" }}>↻</button>
			</div>
			{catalog ? (
				<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
					<button type="button" onClick={() => setCategory("all")}
						style={{ ...chipStyle, ...(category === "all" ? chipOnStyle : null) }}>{t("marketAll")}</button>
					{cats.map((id) => (
						<button key={id} type="button" onClick={() => setCategory(id)}
							style={{ ...chipStyle, ...(category === id ? chipOnStyle : null) }}>{catLabel(id)}</button>
					))}
				</div>
			) : null}
			<p className="muted" style={{ margin: 0, fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>{t("marketHint")}</p>
			{feedback ? <p role="alert" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", color: feedback.severity === "error" ? "var(--dsw-alias-state-error-primary)" : feedback.severity === "warning" ? "var(--dsw-alias-state-warning-primary, #f59e0b)" : "var(--dsw-alias-state-success-primary, #22c55e)" }}>{feedback.message}</p> : null}
			{loadError ? (
				<p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }}>
					{t("marketLoadFail")}: {loadError}
					<button type="button" onClick={refreshCatalog} style={{ ...buttonStyle, marginLeft: 8 }}>{t("marketRetry")}</button>
				</p>
			) : null}
			{catalog === null && !loadError ? <p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("marketLoading")}</p> : null}
			{catalog !== null && visible.length === 0 && !loadError ? <p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("marketEmpty")}</p> : null}
			{shown.length > 0 ? (
				<div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 420, overflow: "auto" }}>
					{shown.map((item) => {
						const installed = entryInstalled(item, installedNames, justInstalled);
						const confirming = confirmEntry === item.name && installing !== item.name;
						return (
							<div key={item.url || item.name} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", borderRadius: 8, padding: "8px 10px" }}>
								<div style={{ flex: "1 1 auto", minWidth: 0 }}>
									<span style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
										<strong style={{ fontSize: 12.5 }}>{item.name}</strong>
										{item.owner ? <span style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>{item.owner}</span> : null}
										{item.stars !== null ? <span style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>★ {item.stars}</span> : null}
										{item.added ? <span style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>{t("marketUpdated")} {item.added.slice(0, 10)}</span> : null}
										<span style={{ fontSize: 10, color: "var(--dsw-alias-label-tertiary)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 4, padding: "0 4px" }}>{catLabel(item.category)}</span>
									</span>
									{item.description ? (() => {
										const desc = item.description[lang] || item.description.en;
										return desc ? <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--dsw-alias-label-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{desc}</p> : null;
									})() : null}
								</div>
								{installed ? (
									<span style={{ fontSize: 11, color: "var(--dsw-alias-state-success-primary, #22c55e)", flex: "none", whiteSpace: "nowrap" }}>✓ {t("marketInstalledBadge")}</span>
								) : installing === item.name ? (
									<button type="button" disabled style={{ ...buttonStyle, flex: "none", fontWeight: 600, opacity: 0.6 }}>{t("marketInstalling")}</button>
								) : confirming ? (
									<button type="button" onClick={() => install(item)} disabled={busy || installing !== null}
										style={{ ...buttonStyle, flex: "none", fontWeight: 700, color: "#fff", background: "var(--dsw-alias-state-error-primary, #d64541)", borderColor: "var(--dsw-alias-state-error-primary, #d64541)" }}>
										{t("marketConfirmInstall")}
									</button>
								) : (
									<button type="button" onClick={() => setConfirmEntry(item.name)} disabled={busy || installing !== null}
										style={{ ...buttonStyle, flex: "none", fontWeight: 600, color: "var(--dsw-alias-state-business-primary, #4f8cff)", borderColor: "var(--dsw-alias-state-business-primary, #4f8cff)" }}>
										{t("marketInstall")}
									</button>
								)}
							</div>
						);
					})}
				</div>
			) : null}
			{hasMore ? (
				<button type="button" onClick={() => setPage((p) => p + 1)} disabled={busy}
					style={{ ...buttonStyle, alignSelf: "center" }}>
					{t("marketMore")}（{visible.length - shown.length}）
				</button>
			) : null}
		</div>
	);
}

const chipStyle = {
	height: 26,
	fontSize: 11.5,
	borderRadius: 999,
	border: "1px solid var(--dsw-alias-border-l2)",
	background: "var(--dsw-alias-bg-layer-1)",
	color: "var(--dsw-alias-label-secondary)",
	padding: "0 12px",
	cursor: "pointer"
};
const chipOnStyle = {
	borderColor: "var(--dsw-alias-state-business-primary, #4f8cff)",
	color: "var(--dsw-alias-state-business-primary, #4f8cff)",
	fontWeight: 600
};

/** 更新源管理面板。 */
function SourcesPanel({ sources, save, busy, t }) {
	const [draft, setDraft] = useState(sources);
	const [newName, setNewName] = useState("");
	const [newUrl, setNewUrl] = useState("");

	useEffect(() => {
		setDraft(sources);
	}, [sources]);

	const setEnabled = (index, enabled) => {
		setDraft((current) => current.map((s, i) => (i === index ? { ...s, enabled } : s)));
	};
	const removeAt = (index) => {
		setDraft((current) => current.filter((_, i) => i !== index));
	};
	const addSource = () => {
		const url = newUrl.trim();
		if (!url || !/^https?:\/\//.test(url)) return;
		let type = "registry";
		if (/^https?:\/\/github\.com\//.test(url)) type = "github";
		else if (/dshfind\.com/.test(url)) type = "dshfind";
		setDraft((current) => [...current, { name: newName.trim() || url, url, enabled: true, official: false, type }]);
		setNewName("");
		setNewUrl("");
	};
	const resetDefaults = () => {
		setDraft([
			{ name: "官方源 (npm)", url: "https://registry.npmjs.org", enabled: true, official: true, type: "registry" },
			{ name: "插件超市 (dshfind)", url: "https://dshfind.com/zh/plugins", enabled: true, official: false, type: "dshfind" },
			{ name: "GitHub 官方仓库", url: "https://github.com/deepseek-ai/deepseek-harness", enabled: false, official: true, type: "github" },
			{ name: "npmmirror 镜像", url: "https://registry.npmmirror.com", enabled: false, official: false, type: "registry" }
		]);
	};

	return (
		<div style={{
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			borderRadius: 8,
			padding: "10px 12px",
			display: "flex",
			flexDirection: "column",
			gap: 8
		}}>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
				<span style={{ fontSize: 13, fontWeight: 600 }}>{t("sourcesTitle")}</span>
				<button type="button" onClick={resetDefaults} style={linkButtonStyle}>{t("resetSources")}</button>
			</div>
			<p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: "18px" }}>{t("sourcesHint")}</p>
			{draft.length === 0 ? <p style={{ margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }}>{t("noSources")}</p> : null}
			<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
				{draft.map((source, index) => (
					<li key={index} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
						<label style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "none", cursor: "pointer" }}>
							<input type="checkbox" checked={source.enabled} onChange={(e) => setEnabled(index, e.currentTarget.checked)} />
							{t("enabled")}
						</label>
						<span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }} title={source.name}>
							{source.name}
							{source.official ? <em style={{ fontStyle: "normal", fontSize: 10, color: "var(--dsw-alias-state-business-primary, #4f8cff)", marginLeft: 4 }}>{t("official")}</em> : null}
							{source.type === "github" ? <em style={{ fontStyle: "normal", fontSize: 10, color: "var(--dsw-alias-label-tertiary)", marginLeft: 4 }}>GitHub</em> : null}
							{source.type === "dshfind" ? <em style={{ fontStyle: "normal", fontSize: 10, color: "var(--dsw-alias-state-warning-primary, #f59e0b)", marginLeft: 4 }}>{t("dshfind")}</em> : null}
						</span>
						<code style={{ flex: "1 1 auto", fontFamily: "var(--ds-font-family-code)", fontSize: 11, color: "var(--dsw-alias-label-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{source.url}</code>
						<button type="button" onClick={() => removeAt(index)} style={linkButtonStyle} disabled={busy}>{t("remove")}</button>
					</li>
				))}
			</ul>
			<div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
				<input value={newName} placeholder={t("sourceName")} onChange={(e) => setNewName(e.currentTarget.value)}
					style={inputStyle} />
				<input value={newUrl} placeholder={t("sourceUrl")} onChange={(e) => setNewUrl(e.currentTarget.value)}
					style={{ ...inputStyle, flex: "1 1 220px" }} />
				<button type="button" onClick={addSource} style={buttonStyle}>{t("addSource")}</button>
			</div>
			<div style={{ display: "flex", justifyContent: "flex-end" }}>
				<button type="button" onClick={() => save(draft)} disabled={busy}
					style={{ ...buttonStyle, background: "var(--dsw-alias-state-business-primary, #4f8cff)", color: "#fff", fontWeight: 600 }}>
					{t("saveSources")}
				</button>
			</div>
		</div>
	);
}

const buttonStyle = {
	border: "1px solid var(--dsw-alias-border-l2)",
	color: "var(--dsw-alias-label-primary)",
	font: "inherit",
	cursor: "pointer",
	background: "transparent",
	borderRadius: 6,
	padding: "4px 10px",
	fontSize: 12
};

const linkButtonStyle = {
	border: "none",
	background: "none",
	color: "var(--dsw-alias-state-business-primary, #4f8cff)",
	font: "inherit",
	fontSize: 12,
	cursor: "pointer",
	padding: "2px 4px"
};

const inputStyle = {
	boxSizing: "border-box",
	height: 30,
	border: "1px solid var(--dsw-alias-border-l2)",
	background: "var(--dsw-alias-bg-layer-1)",
	color: "var(--dsw-alias-label-primary)",
	borderRadius: 6,
	padding: "0 10px",
	fontSize: 12,
	font: "inherit",
	flex: "1 1 140px"
};

/** 本地化文案。 */
/** 侧边栏标签图标（框架传 { size, active }）。 */
function PanelIcon(props) {
	const size = (props && props.size) || 18;
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
			<rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
			<rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
			<rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
		</svg>
	);
}

/** 官方内置可选插件：引擎自带、默认未启用的组合包（OPTIONAL_BUNDLES）+ 自带配置页的官方插件 + 版本豁免。 */
const OFFICIAL_OPTIONAL_LABEL = {
	"@deepseek-ai/dsh-experimental-agent-team-profile": { name: "Agent Team 组合包", note: "多智能体团队协作：成员、任务看板、消息", glyph: "👥" },
	"@deepseek-ai/dsh-experimental-voice-input-bundle": { name: "语音输入", note: "本地语音转写，输入框麦克风入口", glyph: "🎙" },
	"@deepseek-ai/dsh-experimental-auto-review": { name: "自动审阅", note: "高风险操作先自动审阅再执行", glyph: "🛡" }
};

/** 引擎 remote 返回 { ok, value, error }；这里做与 unwrap 同义的宽松解包。 */
function unwrapEngine(result) {
	if (result && typeof result === "object" && "ok" in result) {
		if (result.ok === true) return result.value;
		const error = result.error ?? {};
		throw new Error(`${error.code ?? "remote"}: ${error.message ?? "调用失败"}`);
	}
	return result;
}

function OfficialPluginsPanel({ officialApi, itemsSource, renderSlot, t }) {
	const [state, setState] = useState({ status: "loading" });
	const [busy, setBusy] = useState(null);
	const [feedback, setFeedback] = useState(null);
	const [openItem, setOpenItem] = useState(null);
	const [request, setRequest] = useState(0);

	// C6：官方插件清单按「plugins.item 槽位版本 + 语言版本」做响应式投影（内置页同样跟随 ledger 与 locale），
	// 因此运行时切换界面语言、后台新注册的条目都会实时反映，而不是首帧一次性快照。
	const items = useSyncExternalStore(
		(itemsSource ?? EMPTY_ITEMS_SOURCE).subscribe,
		(itemsSource ?? EMPTY_ITEMS_SOURCE).getSnapshot,
		(itemsSource ?? EMPTY_ITEMS_SOURCE).getSnapshot
	);

	useEffect(() => {
		let alive = true;
		if (!officialApi || typeof officialApi.listBundles !== "function") {
			setState({ status: "unavailable" });
			return () => { alive = false; };
		}
		setState({ status: "loading" });
		Promise.all([
			officialApi.listBundles().then(unwrapEngine),
			typeof officialApi.listVersionExemptions === "function"
				? officialApi.listVersionExemptions().then(unwrapEngine).catch(() => ({ exemptions: {} }))
				: Promise.resolve({ exemptions: {} })
		]).then(([bundles, exemptions]) => {
			if (!alive) return;
			setState({
				status: "ready",
				bundles: Array.isArray(bundles) ? bundles : [],
				exemptions: exemptions && exemptions.exemptions ? exemptions.exemptions : {}
			});
		}, (error) => {
			if (alive) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
		});
		return () => { alive = false; };
	}, [officialApi, request]);

	const optional = state.status === "ready"
		? state.bundles.filter((bundle) => bundle.optional === true || OFFICIAL_OPTIONAL_LABEL[bundle.name] !== undefined)
		: [];

	const toggle = async (bundle, enabled) => {
		if (busy !== null) return;
		setBusy(bundle.name);
		setFeedback(null);
		try {
			// 官方可选包由引擎安装自带，启用 = 把它接入当前 profile（内置页走的是同一条 remote）
			await officialApi.setBundleEnabled(bundle.name, enabled).then(unwrapEngine);
			setFeedback({ severity: "status", message: `${bundle.name}：已${enabled ? "启用" : "停用"}（刷新页面后生效）。` });
			setRequest((value) => value + 1);
		} catch (error) {
			setFeedback({ severity: "error", message: `${bundle.name}：${error instanceof Error ? error.message : String(error)}` });
		} finally {
			setBusy(null);
		}
	};

	const revoke = async (packageVersion, runtimeVersion) => {
		if (busy !== null) return;
		setBusy(packageVersion);
		try {
			await officialApi.setVersionExemption(packageVersion, runtimeVersion, false, true).then(unwrapEngine);
			setFeedback({ severity: "status", message: `${packageVersion}：已撤销 ${runtimeVersion} 的豁免。` });
			setRequest((value) => value + 1);
		} catch (error) {
			setFeedback({ severity: "error", message: String(error instanceof Error ? error.message : error) });
		} finally {
			setBusy(null);
		}
	};

	const cardStyle = { display: "flex", alignItems: "center", gap: 12, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", borderRadius: 10, padding: "12px 14px" };
	const tileStyle = { width: 38, height: 38, flex: "0 0 auto", borderRadius: 9, background: "var(--dsw-alias-bg-layer-3)", display: "grid", placeItems: "center", fontSize: 17 };
	const tagStyle = (color) => ({ border: `1px solid ${color ?? "var(--dsw-alias-border-l2)"}`, color: color ?? "var(--dsw-alias-label-tertiary)", borderRadius: 999, padding: "1px 7px", fontSize: 11, whiteSpace: "nowrap" });
	const exemptionEntries = Object.entries(state.exemptions ?? {});

	if (state.status === "unavailable") {
		return <p style={{ margin: 0, fontSize: 13, color: "var(--dsw-alias-label-tertiary)" }}>{t("officialUnavailable")}</p>;
	}
	if (state.status === "loading") {
		return <p style={{ margin: 0, fontSize: 13, color: "var(--dsw-alias-label-tertiary)" }}>{t("loading")}</p>;
	}
	if (state.status === "error") {
		return (
			<div role="alert" style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, color: "var(--dsw-alias-state-error-primary)" }}>
				<span>{state.message}</span>
				<button type="button" onClick={() => setRequest((value) => value + 1)} style={buttonStyle}>{t("retry")}</button>
			</div>
		);
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			<p style={{ margin: 0, fontSize: 12.5, color: "var(--dsw-alias-label-tertiary)" }}>{t("officialIntro")}</p>
			{feedback ? (
				<p role={feedback.severity === "error" ? "alert" : "status"} style={{ margin: 0, fontSize: 12, color: feedback.severity === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-tertiary)" }}>{feedback.message}</p>
			) : null}

			<div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13, fontWeight: 600 }}>
				{t("officialTitle")}
				<span style={{ color: "var(--dsw-alias-label-tertiary)", fontWeight: 400, fontSize: 12 }}>({optional.length})</span>
			</div>
			{optional.length === 0 ? (
				<p style={{ margin: 0, fontSize: 13, color: "var(--dsw-alias-label-tertiary)" }}>{t("officialEmpty")}</p>
			) : (
				<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
					{optional.map((bundle) => {
						const label = OFFICIAL_OPTIONAL_LABEL[bundle.name] ?? { name: bundle.name, note: bundle.description ?? "", glyph: "📦" };
						const installing = busy === bundle.name;
						return (
							<li key={bundle.name} style={{ display: "block" }}>
								<div style={cardStyle}>
									<div style={tileStyle}>{label.glyph}</div>
									<div style={{ minWidth: 0, flex: "1 1 auto" }}>
										<div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
											<span style={{ fontSize: 14, fontWeight: 600 }}>{label.name}</span>
											{bundle.version ? <span style={{ fontSize: 11.5, color: "var(--dsw-alias-label-tertiary)" }}>v{bundle.version}</span> : null}
											<span style={tagStyle()}>{t("officialOptional")}</span>
											<span style={tagStyle(bundle.enabled ? "var(--dsw-alias-state-success-primary, #22c55e)" : "var(--dsw-alias-state-warning-primary, #f59e0b)")}>
												{bundle.enabled ? t("officialEnabled") : t("officialNotEnabled")}
											</span>
											{bundle.installed ? <span style={tagStyle()}>{t("officialInstalled")}</span> : null}
											{bundle.error ? <span style={tagStyle("var(--dsw-alias-state-error-primary)")}>{String(bundle.error.code ?? "错误")}</span> : null}
										</div>
										<div style={{ fontSize: 12.5, color: "var(--dsw-alias-label-tertiary)", marginTop: 3 }}>{label.note || bundle.name}</div>
										<div style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginTop: 2, fontFamily: "var(--ds-font-family-code)" }}>{bundle.name}</div>
									</div>
									<div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
										{bundle.enabled ? (
											<button type="button" disabled={busy !== null} onClick={() => toggle(bundle, false)}
												style={{ ...buttonStyle, ...(busy !== null ? { opacity: 0.6, cursor: "default" } : null) }}>
												{t("officialDisable")}
											</button>
										) : (
											<button type="button" disabled={busy !== null} onClick={() => toggle(bundle, true)}
												style={{ ...buttonStyle, background: "var(--dsw-alias-state-business-primary, #4f8cff)", borderColor: "transparent", color: "#fff", fontWeight: 600, ...(busy !== null ? { opacity: 0.6, cursor: "default" } : null) }}>
												{installing ? t("officialInstalling") : t("officialInstall")}
											</button>
										)}
									</div>
								</div>
								{!bundle.installed ? (
									<div style={{ marginLeft: 50, marginTop: 4, fontSize: 11.5, color: "var(--dsw-alias-label-tertiary)" }}>{t("installHint")}</div>
								) : null}
							</li>
						);
					})}
				</ul>
			)}

			{items.length > 0 ? (
				<>
					<div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13, fontWeight: 600, marginTop: 6 }}>
						{t("officialItems")}
						<span style={{ color: "var(--dsw-alias-label-tertiary)", fontWeight: 400, fontSize: 12 }}>({items.length})</span>
					</div>
					<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
						{items.map((item) => {
							const expanded = openItem === item.id;
							// C4：只有拿到框架的 renderSlot（= 声明了 plugins.* children 的那条 main 注册）才能渲染配置页；
							// 设置页 tab 的注册没有 children → 不给死按钮，改为指向侧边栏页面的提示。
							const canOpen = typeof renderSlot === "function";
							return (
								<li key={item.id} style={{ display: "block" }}>
									<div style={cardStyle}>
										<div style={tileStyle}>🧩</div>
										<div style={{ minWidth: 0, flex: "1 1 auto" }}>
											<div style={{ fontSize: 14, fontWeight: 600 }}>{item.label}</div>
											<div style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)", fontFamily: "var(--ds-font-family-code)" }}>{item.id}</div>
											{/* C5：契约里 view:'summary' 就是卡片的一行说明（内置页同样请求它） */}
											{canOpen ? (
												<div style={{ marginTop: 3, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" }}>
													{renderSlot("plugins.item", { view: "summary" }, { only: item.id })}
												</div>
											) : (
												<div style={{ marginTop: 3, fontSize: 11.5, color: "var(--dsw-alias-label-tertiary)" }}>{t("configMainPageHint")}</div>
											)}
										</div>
										{canOpen ? (
											<button type="button" onClick={() => setOpenItem(expanded ? null : item.id)} style={buttonStyle}>
												{expanded ? t("officialClose") : t("officialOpen")}
											</button>
										) : null}
									</div>
									{expanded && canOpen ? (
										<div style={{ marginTop: 8, marginLeft: 50, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, padding: "12px 14px", background: "var(--dsw-alias-bg-layer-1)" }}>
											{renderSlot("plugins.item", { view: "page" }, { only: item.id })}
										</div>
									) : null}
								</li>
							);
						})}
					</ul>
				</>
			) : null}

			<div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13, fontWeight: 600, marginTop: 6 }}>
				{t("exemptions")}
				<span style={{ color: "var(--dsw-alias-label-tertiary)", fontWeight: 400, fontSize: 12 }}>({exemptionEntries.length})</span>
			</div>
			{exemptionEntries.length === 0 ? (
				<p style={{ margin: 0, fontSize: 12.5, color: "var(--dsw-alias-label-tertiary)" }}>{t("exemptionsEmpty")}</p>
			) : (
				<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
					{exemptionEntries.flatMap(([packageVersion, runtimes]) => (Array.isArray(runtimes) ? runtimes : []).map((runtimeVersion) => (
						<li key={`${packageVersion}@${runtimeVersion}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary))" }}>
							<code style={{ fontFamily: "var(--ds-font-family-code)" }}>{packageVersion}</code>
							<span style={{ color: "var(--dsw-alias-label-tertiary)" }}>←</span>
							<code style={{ fontFamily: "var(--ds-font-family-code)" }}>{runtimeVersion}</code>
							<button type="button" disabled={busy !== null} onClick={() => revoke(packageVersion, runtimeVersion)} style={{ ...buttonStyle, marginLeft: "auto" }}>
								{t("exemptionRevoke")}
							</button>
						</li>
					)))}
				</ul>
			)}
		</div>
	);
}

/**
 * 页面外壳：把原来挤在列表工具栏里的二级面板拉平成一级 tab，只有一层导航。
 * 官方内置（可选） / 插件列表 / 插件市场 / 操作与场景 / 维护（更新源·救援中心）
 */
function PluginManagerProPage(props) {
	const t = props.t;
	const [tab, setTab] = useState("official");
	const [opsTab, setOpsTab] = useState("history");
	const [maintTab, setMaintTab] = useState("sources");
	const [snapshot, setSnapshot] = useState(null);
	const [busy, setBusy] = useState(null);

	// 市场/更新源/救援需要 profile 快照：原先由内嵌列表各自持有，现在外壳统一拉取
	useEffect(() => {
		if (tab !== "market" && tab !== "maintenance") return undefined;
		let alive = true;
		props.list().then((value) => { if (alive) setSnapshot(value); }, () => { /* 保持空态 */ });
		return () => { alive = false; };
	}, [tab, props.list]);

	const tabs = [
		{ id: "official", label: t("tabOfficial") },
		{ id: "list", label: t("tabAll") },
		{ id: "market", label: t("tabMarket") },
		{ id: "ops", label: t("tabOps") },
		{ id: "maintenance", label: t("tabMaintenance") }
	];
	const tabStyle = (active) => ({
		padding: "7px 11px",
		fontSize: 13,
		font: "inherit",
		cursor: "pointer",
		background: "transparent",
		border: "none",
		borderBottom: `2px solid ${active ? "var(--dsw-alias-state-business-primary, #4f8cff)" : "transparent"}`,
		color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
		fontWeight: active ? 600 : 400
	});
	const segmented = (items, active, onPick) => (
		<div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
			{items.map((item) => (
				<button key={item.id} type="button" onClick={() => onPick(item.id)}
					style={{
						...buttonStyle,
						fontWeight: active === item.id ? 600 : 400,
						// 注意：必须显式给出非选中态的 color/borderColor。若写 undefined，
						// React 在切换时会清掉这两个长属性，border 回退成 currentColor（近黑）
						color: active === item.id ? "var(--dsw-alias-state-business-primary, #4f8cff)" : "var(--dsw-alias-label-primary)",
						borderColor: active === item.id ? "var(--dsw-alias-state-business-primary, #4f8cff)" : "var(--dsw-alias-border-l2)"
					}}>
					{item.label}
				</button>
			))}
		</div>
	);
	const saveSources = async (sources) => {
		setBusy("sources");
		try {
			const next = await props.setSources(sources);
			setSnapshot(next);
		} finally {
			setBusy(null);
		}
	};
	const entries = snapshot !== null ? snapshot.entries : [];

	return (
		// 关键：main 面板不会替本页滚动，页面自己必须是滚动容器
		// （内置页同款 height:100% + overflow:auto）；内层再限宽居中，
		// 否则内容超出视口后下面的插件永远看不到。
		<section data-plugin-panel="plugin-manager-pro" style={{ boxSizing: "border-box", height: "100%", overflowY: "auto", overflowX: "hidden", padding: "22px 26px 44px", color: "var(--dsw-alias-label-primary)" }}>
			<div style={{ maxWidth: 960, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
			<header data-window-drag="true">
				<h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{t("title")}</h1>
				<p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--dsw-alias-label-tertiary)" }}>{t("pageSubtitle")}</p>
			</header>
			<nav style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--dsw-alias-border-l2)", flexWrap: "wrap" }}>
				{tabs.map((item) => (
					<button key={item.id} type="button" onClick={() => setTab(item.id)} style={tabStyle(tab === item.id)}>{item.label}</button>
				))}
			</nav>

			{tab === "official" ? (
				<TabBoundary>
					<OfficialPluginsPanel officialApi={props.officialApi} itemsSource={props.officialItemsSource} renderSlot={props.renderSlot} t={t} />
				</TabBoundary>
			) : null}

			{tab === "list" ? <TabBoundary><PluginManagerTab {...props} embedded /></TabBoundary> : null}

			{tab === "market" ? (
				<TabBoundary>
					<MarketPanel marketCatalog={props.marketCatalog} marketInstall={props.marketInstall} busy={busy !== null} t={t} entries={entries} />
				</TabBoundary>
			) : null}

			{tab === "ops" ? (
				<TabBoundary>
					{segmented([{ id: "history", label: t("history") }, { id: "scenarios", label: t("scenarios") }], opsTab, setOpsTab)}
					{opsTab === "history"
						? <HistoryPanel operationHistory={props.operationHistory} undoOperation={props.undoOperation} onSnapshot={setSnapshot} t={t} />
						: <ScenarioPanel
							scenarioList={props.scenarioList}
							scenarioSave={props.scenarioSave}
							scenarioUpdate={props.scenarioUpdate}
							scenarioDelete={props.scenarioDelete}
							scenarioApply={props.scenarioApply}
							onSnapshot={setSnapshot}
							t={t}
						/>}
				</TabBoundary>
			) : null}

			{tab === "maintenance" ? (
				<TabBoundary>
					{segmented([{ id: "sources", label: t("sources") }, { id: "rescue", label: t("rescue") }], maintTab, setMaintTab)}
					{maintTab === "sources"
						? <SourcesPanel sources={snapshot !== null ? snapshot.sources : []} save={saveSources} busy={busy !== null} t={t} />
						: <RescuePanel
							diagnose={props.diagnose}
							quarantine={props.quarantine}
							repairHarness={props.repairHarness}
							restartHarness={props.restartHarness}
							uninstallPackages={props.uninstallPackages}
							uninstallPreview={props.uninstallPreview}
							getRescueConfig={props.getRescueConfig}
							setRescueConfig={props.setRescueConfig}
							getDownloadConfig={props.getDownloadConfig}
							checkDownloads={props.checkDownloads}
							verifyProfile={props.verifyProfile}
							fixProfile={props.fixProfile}
							managed={entries.filter((entry) => entry.origin === "user")}
							t={t}
						/>}
				</TabBoundary>
			) : null}
			</div>
		</section>
	);
}

const zh = {
	tab: "插件管理",
	tabOfficial: "官方内置（可选）",
	tabAll: "全部插件",
	tabUpdate: "可更新",
	tabMarket: "插件市场",
	tabOps: "操作与场景",
	tabMaintenance: "维护",
	onlyUpdatable: "仅显示可更新",
	pageSubtitle: "已接管内置插件页 · 侧边栏「插件管理」",
	officialTitle: "官方内置可选插件",
	officialIntro: "引擎自带、默认未启用的能力包；启用后即可使用，部分插件还自带配置页。",
	officialEmpty: "没有发现官方可选插件。",
	officialUnavailable: "引擎未提供官方插件清单接口（pluginManager remote 不可用）。",
	officialInstall: "启用",
	officialInstalling: "启用中…",
	officialDisable: "停用",
	officialInstalled: "已安装",
	officialNotInstalled: "未安装",
	officialEnabled: "已启用",
	officialNotEnabled: "未启用",
	officialOptional: "可选",
	officialItems: "自带配置页的官方插件",
	officialOpen: "打开配置页",
	officialClose: "收起",
	exemptions: "版本豁免",
	exemptionsEmpty: "暂无版本豁免记录。",
	exemptionRevoke: "撤销",
	installHint: "「启用」会通过 pnpm 安装该组合包，可能需要下载依赖。",
	title: "插件管理",
	profile: "当前配置",
	search: "搜索插件名称/简介/包名",
	refresh: "检查更新并刷新状态",
	loading: "正在读取插件…",
	error: "暂时无法读取插件。",
	retry: "重试",
	empty: "暂无可显示的插件。",
	emptySearch: "没有匹配的插件。",
	legendNecessity: "必要程度",
	legendStatus: "启用状态",
	legendOrigin: "来源",
	originLegend: "来源",
	originAll: "全部",
	originBuiltin: "架构自带",
	originUser: "用户安装",
	originUserHint: "用户/agent 安装：dsh plugin add 或插件市场安装",
	configEntry: "配置",
	configEntryHint: "打开该插件的自带配置面板（由插件自身提供）",
	configBundleEntry: "插件配置",
	configMainPageHint: "请在侧边栏「插件管理」页中打开该配置页。",
	necessityCore: "必须",
	necessityRecommended: "推荐",
	necessityOptional: "可选",
	statusError: "错误/需检查",
	statusUpdate: "需更新",
	statusDisabled: "未启用",
	statusEnabled: "启用",
	enableEntry: "启用",
	disableEntry: "停用",
	versionUnknown: "版本未知",
	update: "更新",
	updateInternal: "内置",
	updateInternalHint: "使用管理器内置下载器（HTTP/P2P/aria2），不走浏览器下载",
	updateAll: "全部更新",
	upToDate: "已是最新版本",
	notManaged: "随安装更新",
	updateAvailable: "可更新",
	expandAll: "全部展开",
	collapseAll: "全部收起",
	sources: "更新源",
	sourcesTitle: "更新源配置",
	sourcesHint: "版本检查与更新从启用的源获取；官方 npm 源与 GitHub 官方仓库已预填。GitHub 源适用于仓库根 package.json 的 name 匹配包名、并以 GitHub Releases 发版的插件。可添加私有/镜像 registry。",
	sourcesSaved: "更新源已保存，正在重新检查版本…",
	resetSources: "恢复默认源",
	addSource: "添加",
	remove: "删除",
	sourceName: "源名称",
	sourceUrl: "源地址 (https://…)",
	saveSources: "保存更新源",
	official: "官方",
	enabled: "启用",
	noSources: "没有启用的更新源，版本检查不可用。",
	dshfind: "超市",
	resetToggles: "重置开关",
	resetConfirm: "确定还原所有由管理器修改的插件开关状态？（仅清除管理器写入的行，不影响用户自定义配置）",
	resetDone: "已还原所有开关状态。",
	archived: "架构保留",
	rescue: "救砖",
	rescueTitle: "救援中心",
	rescueHint: "诊断加载失败的插件并隔离/卸载；一键修复会重置开关、隔离问题插件、清空缓存。独立救援页 http://127.0.0.1:3080/rescue 在设置页不可用时仍可访问（右下角 🛟 按钮）。",
	rescueDiagnose: "运行诊断",
	rescueClean: "✓ 未发现加载失败或运行期错误。",
	rescueDisable: "禁用此插件",
	rescueUninstall: "卸载",
	rescueProtected: "救援保护条目",
	rescueRepair: "一键修复引擎",
	rescueRepairConfirm: "确认执行修复？将重置管理器开关、隔离全部失败插件并清空缓存。",
	rescueRepairDone: "✓ 修复完成",
	rescueRestartHint: "重启命令：",
	rescueRestart: "重启引擎",
	rescueRestartConfirm: "确认重启 dsh web 引擎？当前页面将断连，约 3-5 秒后恢复（请刷新页面）。",
	rescueAuto: "失败插件自动隔离",
	rescueAutoSaved: "自动隔离设置已保存。",
	rescueUninstallList: "可卸载的 profile 依赖：",
	rescueUninstallConfirm: "确认卸载",
	// —— 来源人工修正 ——
	sourceOverrideHint: "来源标签（自动判定，可手动覆盖并持久化）",
	sourceAuto: "自动",
	sourceNpm: "npm",
	sourceGithub: "GitHub",
	sourceLocal: "本地",
	sourceBuiltin: "内置",
	// —— 事务化卸载 ——
	uninstallTitle: "卸载影响预览",
	uninstallRowHint: "卸载该插件",
	uninstallPreviewLoading: "正在分析影响范围…",
	uninstallPreviewFail: "影响预览失败",
	uninstallPreviewHint: "将执行事务化卸载：备份配置 → 删除目标包与补丁行 → 校验 → 异常自动回滚。请确认影响范围：",
	uninstallAffectedEntries: "将移除的插件条目",
	uninstallNoEntries: "该包没有注册插件条目（仅移除依赖）。",
	uninstallBundleRow: "该包在 bundles 清单中（将移除启动声明）。",
	uninstallPatchRows: "将清理的管理器开关行",
	uninstallDependents: "以下已安装插件依赖该包，卸载会造成依赖断裂",
	uninstallCascade: "级联卸载依赖插件",
	uninstallConfirm: "确认卸载",
	uninstalling: "卸载中…",
	uninstallStatusremoved: "已卸载",
	uninstallStatusrolledback: "已回滚",
	uninstallStatusfailed: "失败",
	"uninstallStatusnot-managed": "无法卸载",
	uninstallVerifyOk: "卸载后自检通过，重启 profile 后生效。",
	uninstallReportRows: "清理的开关行",
	uninstallReportCascade: "级联卸载",
	uninstallResiduals: "残留目录（下次启动自动清理）",
	uninstallNotManaged: "该包不是本 profile 的依赖，无法卸载。",
	uninstallLocalBlocked: "本地包请用 dsh plugin --profile <name> remove 卸载。",
	done: "完成",
	cancel: "取消",
	// —— 操作历史 ——
	history: "历史",
	historyTitle: "操作历史",
	historyHint: "最近 20 次操作（卸载/开关/场景/重置），可一键撤销",
	historyEmpty: "暂无操作记录。",
	historyUndo: "撤销",
	historyUndone: "已撤销",
	// —— 场景方案 ——
	scenarios: "场景",
	scenarioTitle: "场景方案",
	scenarioHint: "保存当前插件启停组合，一键切换（应用前展示变更预览；受保护条目自动跳过）",
	scenarioName: "场景名称（如：办公 / 写作 / 演示）",
	scenarioSave: "保存当前状态",
	scenarioSaved: "场景已保存。",
	scenarioEmpty: "暂无场景。调整插件开关后点「保存当前状态」创建。",
	scenarioApply: "应用",
	scenarioApplyConfirm: "确认切换？",
	scenarioApplying: "切换中…",
	scenarioCalculating: "正在计算变更…",
	scenarioPreviewTitle: "切换预览（该场景会变更以下条目）：",
	scenarioCounts: "启/停",
	scenarioUpdate: "更新",
	scenarioUpdateHint: "用当前状态覆盖此场景",
	scenarioDelete: "删除",
	scenarioDeleteConfirm: "确认删除场景",
	scenarioApplied: "场景已应用",
	restartHint: "如运行期未收敛，重启 profile 后生效。",
	market: "市场",
	marketTitle: "插件市场（dshfind 精选目录）",
	marketSearch: "搜索插件（名称/仓库/描述）…",
	marketHint: "目录来自 awesome-dsh-plugin 精选收录；带 npm 包名的优先走 npm registry 直装（预构建产物），GitHub 仓库走内置下载器。装完在管理列表可见，重启后生效。",
	marketLoading: "加载目录中…",
	marketEmpty: "没有匹配的插件。",
	marketMore: "加载更多",
	marketInstall: "安装",
	marketConfirmInstall: "确认安装？",
	marketInstalling: "安装中…",
	marketInstalledBadge: "已安装",
	marketLoadFail: "目录加载失败",
	marketRetry: "重试",
	marketRefresh: "刷新目录",
	marketAll: "全部",
	marketSort: "排序",
	marketSortStars: "按星标",
	marketSortAdded: "按收录时间",
	marketPlugins: "个插件",
	marketUpdated: "收录",
	marketSourceLive: "在线目录",
	marketSourceCache: "缓存",
	marketSourceFallback: "GitHub 兜底",
	marketSourceError: "目录不可用",
	verifyTitle: "启动前自检",
	verifyRun: "运行检查",
	verifyOk: "✓ profile 配置正常，引擎可以正常启动。",
	verifyBad: "⚠ 发现问题（引擎可能无法启动）：",
	verifyHint: "损坏的 bundle（包未安装/未声明 dsh.bundle）或无法解析的 cordis.patch.yml 会让引擎在启动阶段失败——这是救砖的首要修复目标；双击桌面快捷方式启动时也会自动执行同样的检查。",
	fixProfile: "修复引擎配置",
	fixProfileConfirm: "确认执行？将备份并隔离损坏的 bundle、还原损坏的补丁文件。",
	dlTitle: "下载目录（自动安装）",
	dlCheck: "检查下载",
	dlDir: "下载目录",
	dlHint: "用浏览器 / NDM / aria2 等任意方式把插件包（.tgz）下载到该目录，点击「检查下载」或重启后自动安装。NDM 扩展可直接捕获下载到此目录。",
	dlInstalled: "已安装：",
	dlFailed: "失败：",
	dlEmpty: "目录中没有待安装的新插件包。"
};

const en = {
	tab: "Plugin manager",
	tabOfficial: "Official (optional)",
	tabAll: "All plugins",
	tabUpdate: "Updates",
	tabMarket: "Market",
	tabOps: "Operations",
	tabMaintenance: "Maintenance",
	onlyUpdatable: "Updates only",
	pageSubtitle: "Takes over the built-in Plugins page · sidebar entry",
	officialTitle: "Official optional plugins",
	officialIntro: "Capability bundles shipped with the engine but off by default. Some register their own configuration page.",
	officialEmpty: "No official optional plugins found.",
	officialUnavailable: "The engine's official plugin inventory is unavailable (pluginManager remote missing).",
	officialInstall: "Enable",
	officialInstalling: "Enabling…",
	officialDisable: "Disable",
	officialInstalled: "Installed",
	officialNotInstalled: "Not installed",
	officialEnabled: "Enabled",
	officialNotEnabled: "Off",
	officialOptional: "Optional",
	officialItems: "Official plugins with their own page",
	officialOpen: "Open page",
	officialClose: "Collapse",
	exemptions: "Version exemptions",
	exemptionsEmpty: "No version exemptions.",
	exemptionRevoke: "Revoke",
	installHint: "Enabling installs this bundle through pnpm and may download packages.",
	title: "Plugin manager",
	profile: "Active profile",
	search: "Search by name, description or package",
	refresh: "Check updates and refresh",
	loading: "Reading plugins…",
	error: "Plugins are temporarily unavailable.",
	retry: "Retry",
	empty: "No plugins are available.",
	emptySearch: "No matching plugins.",
	legendNecessity: "Necessity",
	legendStatus: "Status",
	legendOrigin: "Origin",
	originLegend: "Origin",
	originAll: "All",
	originBuiltin: "Built-in",
	originUser: "User-installed",
	originUserHint: "Installed by you or an agent via `dsh plugin add` or the plugin market",
	configEntry: "Config",
	configEntryHint: "Open this plugin's own config panel (provided by the plugin itself)",
	configBundleEntry: "Plugin config",
	configMainPageHint: "Open this config page from the sidebar Plugin manager entry.",
	necessityCore: "Essential",
	necessityRecommended: "Recommended",
	necessityOptional: "Optional",
	statusError: "Error/Check",
	statusUpdate: "Update",
	statusDisabled: "Disabled",
	statusEnabled: "Enabled",
	enableEntry: "Enable",
	disableEntry: "Disable",
	versionUnknown: "version unknown",
	update: "Update",
	updateInternal: "Built-in",
	updateInternalHint: "Use the manager's built-in downloader (HTTP/P2P/aria2) instead of the browser",
	updateAll: "Update all",
	upToDate: "Already up to date",
	notManaged: "ships with install",
	updateAvailable: "updates",
	expandAll: "Expand all",
	collapseAll: "Collapse all",
	sources: "Sources",
	sourcesTitle: "Update sources",
	sourcesHint: "Version checks and updates use the enabled sources; the official npm source and the GitHub official repo are pre-filled. A GitHub source applies to packages whose repo-root package.json name matches and which release via GitHub Releases. Private/mirror registries can be added.",
	sourcesSaved: "Sources saved; re-checking versions…",
	resetSources: "Reset to defaults",
	addSource: "Add",
	remove: "Remove",
	sourceName: "Name",
	sourceUrl: "URL (https://…)",
	saveSources: "Save sources",
	official: "official",
	enabled: "enabled",
	noSources: "No enabled sources; version checks unavailable.",
	dshfind: "market",
	resetToggles: "Reset toggles",
	resetConfirm: "Reset every plugin toggle changed by this manager? (Only manager-owned rows are cleared; your own config is untouched.)",
	resetDone: "All toggles have been reset.",
	archived: "archived",
	rescue: "Rescue",
	rescueTitle: "Rescue center",
	rescueHint: "Diagnose failing plugins and quarantine/uninstall them; one-click repair resets toggles, quarantines failing plugins and clears caches. The standalone rescue page http://127.0.0.1:3080/rescue works even when the settings page is broken (🛟 button, bottom right).",
	rescueDiagnose: "Diagnose",
	rescueClean: "✓ No failing plugins found.",
	rescueDisable: "Disable",
	rescueUninstall: "Uninstall",
	rescueProtected: "protected",
	rescueRepair: "Repair harness",
	rescueRepairConfirm: "Run repair? This resets manager toggles, quarantines every failing plugin and clears caches.",
	rescueRepairDone: "✓ Repair done",
	rescueRestartHint: "Restart command:",
	rescueRestart: "Restart engine",
	rescueRestartConfirm: "Restart the dsh web engine? This page will disconnect and return in ~3-5s (refresh then).",
	rescueAuto: "Auto-quarantine failing plugins",
	rescueAutoSaved: "Auto-quarantine setting saved.",
	rescueUninstallList: "Uninstallable profile dependencies:",
	rescueUninstallConfirm: "Uninstall",
	// —— Source override ——
	sourceOverrideHint: "Source label (auto-detected; can be overridden and persisted)",
	sourceAuto: "auto",
	sourceNpm: "npm",
	sourceGithub: "GitHub",
	sourceLocal: "local",
	sourceBuiltin: "built-in",
	// —— Transactional uninstall ——
	uninstallTitle: "Uninstall impact preview",
	uninstallRowHint: "Uninstall this plugin",
	uninstallPreviewLoading: "Analyzing impact…",
	uninstallPreviewFail: "Preview failed",
	uninstallPreviewHint: "Transactional uninstall: backup configs → remove the package and patch rows → verify → automatic rollback on failure. Review the impact:",
	uninstallAffectedEntries: "Plugin entries to be removed",
	uninstallNoEntries: "This package registers no plugin entries (dependency only).",
	uninstallBundleRow: "It is listed in the profile bundles (boot declaration will be removed).",
	uninstallPatchRows: "Manager patch rows to be cleaned",
	uninstallDependents: "These installed plugins depend on this package; uninstalling will break them",
	uninstallCascade: "Cascade-uninstall dependents",
	uninstallConfirm: "Confirm uninstall",
	uninstalling: "Uninstalling…",
	uninstallStatusremoved: "Removed",
	uninstallStatusrolledback: "Rolled back",
	uninstallStatusfailed: "Failed",
	"uninstallStatusnot-managed": "Not managed",
	uninstallVerifyOk: "Post-uninstall health check passed; it takes effect after a profile restart.",
	uninstallReportRows: "Patch rows cleaned",
	uninstallReportCascade: "Cascade removed",
	uninstallResiduals: "Residual directories (auto-cleaned at next start)",
	uninstallNotManaged: "This package is not a dependency of this profile; it cannot be uninstalled.",
	uninstallLocalBlocked: "Local package — use `dsh plugin --profile <name> remove`.",
	done: "Done",
	cancel: "Cancel",
	// —— Operation history ——
	history: "History",
	historyTitle: "Operation history",
	historyHint: "Last 20 operations (uninstall/toggle/scenario/reset), one-click undo",
	historyEmpty: "No operations yet.",
	historyUndo: "Undo",
	historyUndone: "undone",
	// —— Scenarios ——
	scenarios: "Scenarios",
	scenarioTitle: "Scenarios",
	scenarioHint: "Save the current plugin state as a named scenario and switch with one click (change preview before applying; protected entries are skipped)",
	scenarioName: "Scenario name (e.g. office / writing / demo)",
	scenarioSave: "Save current state",
	scenarioSaved: "Scenario saved.",
	scenarioEmpty: "No scenarios. Toggle plugins, then click \"Save current state\".",
	scenarioApply: "Apply",
	scenarioApplyConfirm: "Confirm switch?",
	scenarioApplying: "Switching…",
	scenarioCalculating: "Calculating changes…",
	scenarioPreviewTitle: "Preview (this scenario changes):",
	scenarioCounts: "on/off",
	scenarioUpdate: "Update",
	scenarioUpdateHint: "Overwrite this scenario with the current state",
	scenarioDelete: "Delete",
	scenarioDeleteConfirm: "Delete scenario",
	scenarioApplied: "Scenario applied",
	restartHint: "If runtime state does not converge, restart the profile.",
	market: "Market",
	marketTitle: "Plugin market (dshfind curated catalog)",
	marketSearch: "Search plugins (name/repo/description)…",
	marketHint: "Catalog from awesome-dsh-plugin; entries with an npm name install from the npm registry (prebuilt), GitHub repos use the built-in downloader. Installed plugins appear in the management list after restart.",
	marketLoading: "Loading catalog…",
	marketEmpty: "No matching plugins.",
	marketMore: "Load more",
	marketInstall: "Install",
	marketConfirmInstall: "Confirm install?",
	marketInstalling: "Installing…",
	marketInstalledBadge: "Installed",
	marketLoadFail: "Failed to load catalog",
	marketRetry: "Retry",
	marketRefresh: "Refresh catalog",
	marketAll: "All",
	marketSort: "Sort",
	marketSortStars: "By stars",
	marketSortAdded: "By added date",
	marketPlugins: "plugins",
	marketUpdated: "Added",
	marketSourceLive: "live catalog",
	marketSourceCache: "cached",
	marketSourceFallback: "GitHub fallback",
	marketSourceError: "catalog unavailable",
	verifyTitle: "Pre-boot check",
	verifyRun: "Run check",
	verifyOk: "✓ Profile configuration is healthy; the engine can boot.",
	verifyBad: "⚠ Issues found (the engine may fail to boot):",
	verifyHint: "Broken bundles (uninstalled / no dsh.bundle) or an unparsable cordis.patch.yml fail the engine during boot — the primary rescue target. The desktop shortcut runs the same check on double-click.",
	fixProfile: "Fix engine config",
	fixProfileConfirm: "Run fix? Broken bundles will be backed up and removed from the profile; a corrupt patch file will be restored.",
	dlTitle: "Download folder (auto-install)",
	dlCheck: "Check folder",
	dlDir: "Download folder",
	dlHint: "Download plugin packages (.tgz) into this folder with any tool (browser / NDM / aria2), then click \"Check folder\" or restart — they are installed automatically. The NDM extension can capture downloads there.",
	dlInstalled: "Installed:",
	dlFailed: "Failed:",
	dlEmpty: "No new packages waiting in the download folder."
};

const inject = [
	"slots",
	"locale",
	"remote"
];

/** 挂载远程面并注册「插件管理」tab（替换只读清单页）。 */
async function apply(ctx) {
	const TYPERT_REMOTE = (await import("../lib/remote.js")).TYPERT_REMOTE;
	const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
	const disposeLocale = ctx.locale.register(NS, { zh, en });
	const feature = ctx.inject(["remote.pluginManagerPro"], (scope) => {
		const t = scope.locale.bind(NS);
		const unwrap = (result) => {
			if (result.ok) return result.value;
			throw new Error(`${result.error.code}: ${result.error.message}`);
		};
		// 远程调用超时：连接异常时给出明确错误而不是永久转圈
		const withTimeout = (promise, label, ms = 30000) => Promise.race([
			promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}：操作超时（${Math.round(ms / 1000)} 秒）`)), ms))
		]);
		const api = {
			list: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.list(), "读取插件列表")),
			// 全量刷新 = 165 包 × 所有源，放宽到 4 分钟（网络正常约 20-30s）
			refresh: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.refresh(), "检查更新", 240000)),
			setEnabled: async (entryId, enabled) => unwrap(await withTimeout(scope.remote.pluginManagerPro.setEnabled(entryId, enabled), "切换插件状态")),
			update: async (packageNames) => unwrap(await withTimeout(scope.remote.pluginManagerPro.update(packageNames), "更新插件")),
			setSources: async (sources) => unwrap(await withTimeout(scope.remote.pluginManagerPro.setSources(sources), "保存更新源")),
			resetToggles: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.resetToggles(), "重置开关")),
			diagnose: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.diagnose(), "诊断")),
			quarantine: async (entryIds) => unwrap(await withTimeout(scope.remote.pluginManagerPro.quarantine(entryIds), "隔离插件")),
			repairHarness: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.repairHarness(), "修复引擎")),
			restartHarness: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.restartHarness(), "重启引擎")),
			uninstallPackages: async (packageNames, options) => unwrap(await withTimeout(scope.remote.pluginManagerPro.uninstallPackages(packageNames, options ?? { cascade: false }), "卸载插件", 300000)),
			uninstallPreview: async (packageNames) => unwrap(await withTimeout(scope.remote.pluginManagerPro.uninstallPreview(packageNames), "卸载影响预览", 60000)),
			operationHistory: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.operationHistory(), "读取操作历史")),
			undoOperation: async (id) => unwrap(await withTimeout(scope.remote.pluginManagerPro.undoOperation(id), "撤销操作", 300000)),
			setSourceOverride: async (packageName, source) => unwrap(await withTimeout(scope.remote.pluginManagerPro.setSourceOverride(packageName, source), "保存来源标签")),
			scenarioList: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.scenarioList(), "读取场景方案")),
			scenarioSave: async (name) => unwrap(await withTimeout(scope.remote.pluginManagerPro.scenarioSave(name), "保存场景")),
			scenarioUpdate: async (id) => unwrap(await withTimeout(scope.remote.pluginManagerPro.scenarioUpdate(id), "更新场景")),
			scenarioDelete: async (id) => unwrap(await withTimeout(scope.remote.pluginManagerPro.scenarioDelete(id), "删除场景")),
			scenarioApply: async (id, dryRun) => unwrap(await withTimeout(scope.remote.pluginManagerPro.scenarioApply(id, dryRun), "应用场景")),
			getRescueConfig: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.getRescueConfig(), "读取救援配置")),
			setRescueConfig: async (config) => unwrap(await withTimeout(scope.remote.pluginManagerPro.setRescueConfig(config), "保存救援配置")),
			getDownloadConfig: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.getDownloadConfig(), "读取下载目录")),
			checkDownloads: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.checkDownloads(), "检查下载目录")),
			resolveDownloadUrl: async (packageName) => unwrap(await withTimeout(scope.remote.pluginManagerPro.resolveDownloadUrl(packageName), "解析下载链接")),
			verifyProfile: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.verifyProfile(), "启动前自检")),
			fixProfile: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.fixProfile(), "修复引擎配置")),
			updateBrowser: async (packageNames) => unwrap(await withTimeout(scope.remote.pluginManagerPro.updateBrowser(packageNames), "解析下载链接")),
			marketCatalog: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.marketCatalog(), "加载插件市场", 20000)),
			// 市场安装走 pnpm，可能下载 + 编译数分钟：超时放宽到 4 分钟
			marketInstall: async (target, dryRun) => unwrap(await withTimeout(scope.remote.pluginManagerPro.marketInstall(target, dryRun), "安装插件", 240000))
		};
		// C3：旧的 `settings.plugin.item`（旧设置页插件配置卡片）在 0.1.7 已无声明者 —— 整段读取与渲染均已删除，
		// 第三方配置改由下面两个 0.1.7 现役槽位承担（键规则见 configSurfacesFor）。

		/**
		 * `plugins.row.config` / `plugins.bundle.config` 的**已注册键**快照。
		 * useSyncExternalStore 源：getSnapshot 按槽位 version 缓存，保证引用稳定（否则会无限重渲染）；
		 * 订阅槽位变更 → 后注册/注销的配置出口都能实时出现/消失。
		 */
		const configSurfacesSource = (() => {
			let stamp = "";
			let cached = { rows: [], bundles: [] };
			const read = () => {
				const keysOf = (name) => {
					const keys = [];
					for (const entry of scope.slots.entriesOfSlot(name) ?? []) {
						const key = entry?.options?.key;
						if (typeof key === "string" && key !== "") keys.push(key);
					}
					return keys.sort();
				};
				return { rows: keysOf("plugins.row.config"), bundles: keysOf("plugins.bundle.config") };
			};
			return {
				getSnapshot: () => {
					const next = `${scope.slots.getVersion("plugins.row.config")}:${scope.slots.getVersion("plugins.bundle.config")}`;
					if (next !== stamp) {
						stamp = next;
						cached = read();
					}
					return cached;
				},
				subscribe: (listener) => {
					const offRow = scope.slots.subscribe("plugins.row.config", listener);
					const offBundle = scope.slots.subscribe("plugins.bundle.config", listener);
					return () => {
						offRow();
						offBundle();
					};
				}
			};
		})();

		// 引擎自带远程面（懒注入：拿不到也不影响自研功能；官方可选插件子页用）
		const engineRemote = { api: null };
		ctx.inject(["remote.pluginManager"], (engineScope) => {
			const remote = engineScope.remote.pluginManager;
			if (remote === undefined) return;
			engineRemote.api = {
				listBundles: () => remote.listBundles(),
				setBundleEnabled: (name, enabled) => remote.setBundleEnabled(name, enabled),
				listVersionExemptions: () => remote.listVersionExemptions(),
				setVersionExemption: (packageVersion, runtimeVersion, enabled, acceptRisk) => remote.setVersionExemption(packageVersion, runtimeVersion, enabled, acceptRisk)
			};
		});

		/**
		 * 官方插件自带配置页（`plugins.item` 注册）的响应式清单：
		 * 跟随槽位版本与语言版本（label 是 thunk，切换语言后按新语言重读），与内置页的投影一致。
		 */
		const officialItemsSource = (() => {
			let stamp = "";
			let cached = [];
			const read = () => {
				try {
					return (scope.slots.entriesOfSlot("plugins.item") ?? []).map((entry) => {
						const id = entry?.options?.id ?? "";
						let label = id;
						try {
							const l = entry?.options?.label;
							if (typeof l === "function") label = String(l() ?? id);
						} catch { /* 保留 id */ }
						return { id, label };
					}).filter((item) => item.id !== "");
				} catch { return []; }
			};
			return {
				getSnapshot: () => {
					const next = `${scope.slots.getVersion("plugins.item")}:${scope.locale.getSnapshot().revision}`;
					if (next !== stamp) {
						stamp = next;
						cached = read();
					}
					return cached;
				},
				subscribe: (listener) => {
					const offItems = scope.slots.subscribe("plugins.item", listener);
					const offLocale = scope.locale.subscribe(listener);
					return () => {
						offItems();
						offLocale();
					};
				}
			};
		})();

		const pagePropsInjected = () => ({
			...api,
			t,
			officialApi: engineRemote.api,
			officialItemsSource,
			// 注意：**不要**在这里返回 renderSlot —— renderSlot 由框架 kit 注入
			// （只有声明了 plugins.* children 的那条 main 注册才拿得到；inject 若返回同名键会覆盖它）。
			// 设置页 tab 那条注册没有 children → props.renderSlot 为 undefined → 页面自动降级为「无出口 + 提示」。
			configSurfaces: configSurfacesSource
		});

		// ① 设置页入口（保留）：同一个页面外壳，避免两套 UI 并存
		scope.slots.inject("settings.plugins.tab", () => scope.slots.register({
			name: "settings.plugins.tab",
			id: "pluginManagerPro",
			order: 60,
			label: () => t("tab"),
			locale: NS,
			inject: pagePropsInjected
		}, PluginManagerProPage));

		// ② 侧边栏一级入口：接管内置插件页（profile patch 里已 `ui-plugin-manager: disabled`）
		scope.slots.inject("sidebar.panellist", () => scope.slots.register({
			name: "sidebar.panellist",
			id: "plugins",
			order: 0,
			label: () => t("tab"),
			locale: NS
		}, PanelIcon));

		// ③ 主面板 + 声明并托管内置页原来的 7 个 plugins.* 子槽位（第三方配置出口落到本页）
		scope.slots.inject("main", function* () {
			yield scope.slots.register({
				name: "main",
				key: "plugins",
				locale: NS,
				inject: pagePropsInjected,
				children: {
					"plugins.item": { kind: "list", scope: "root" },
					"plugins.bundle.activation": { kind: "keyed", scope: "root" },
					"plugins.bundle.config": { kind: "keyed", scope: "root" },
					"plugins.row.config": { kind: "keyed", scope: "root" },
					"plugins.detail.actions": { kind: "list", scope: "root" },
					"plugins.detail.badge": { kind: "list", scope: "root" },
					"plugins.detail.section": { kind: "list", scope: "root" }
				}
			}, PluginManagerProPage);
		});

		// ④ 与内置页保持互操作：别的插件用 pluginNavigation.openBundle(pkg) 跳转
		ctx.inject(["layout"], (layoutScope) => {
			const layout = typeof layoutScope.get === "function" ? layoutScope.get("layout") : layoutScope.layout;
			if (layout === undefined || typeof layout.selectPanel !== "function") return;
			layoutScope.effect(() => layoutScope.reflect.provide("pluginNavigation", {
				openBundle: () => {
					try { layout.selectPanel("plugins"); } catch { /* 面板不可选时忽略 */ }
				}
			}));
		});
	});
	// 浮动救援球：设置页/其他 UI 插件损坏时仍可进入 /rescue 救援页
	let rescueBall = null;
	if (typeof document !== "undefined" && document.body !== null) {
		rescueBall = document.createElement("button");
		rescueBall.textContent = "🛟";
		rescueBall.title = "DSH 救援中心（设置页不可用时的救砖入口）";
		rescueBall.setAttribute("aria-label", "DSH 救援中心");
		rescueBall.style.cssText = "position:fixed;right:14px;bottom:14px;width:40px;height:40px;border-radius:50%;border:1px solid #d64541;background:#d64541;color:#fff;font-size:18px;cursor:pointer;z-index:2147483000;box-shadow:0 2px 10px rgba(0,0,0,.45);display:grid;place-items:center;";
		rescueBall.addEventListener("click", () => {
			window.open("/rescue", "_blank");
		});
		document.body.appendChild(rescueBall);
	}
	return async () => {
		if (rescueBall !== null && rescueBall.parentNode !== null) rescueBall.parentNode.removeChild(rescueBall);
		await feature.dispose();
		disposeLocale();
		await disposeRemote();
	};
}

export { PluginManagerTab, OfficialPluginsPanel, apply, inject, marketFilterItems, entryInstalled, configSurfacesFor };
