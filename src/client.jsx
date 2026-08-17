// namespace import：shell 的 react 是 CJS（module.exports = React，无 default），
// default 导入会被 esbuild 生成 .default 引用导致运行时崩溃（TabBoundary extends undefined）。
import * as React from "react";
const { useEffect, useMemo, useState } = React;

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

/** 状态优先：错误(红) > 需更新(黄) > 未启用(灰)/启用(绿)。 */
function statusOf(entry) {
	if (entry.phase === "failed" || entry.error) return "error";
	if (entry.needsUpdate === true) return "update";
	return entry.enabled ? "enabled" : "disabled";
}

function PluginManagerTab({ list, refresh, setEnabled, update, setSources, resetToggles, diagnose, quarantine, repairHarness, restartHarness, uninstallPackages, getRescueConfig, setRescueConfig, getDownloadConfig, checkDownloads, updateBrowser, verifyProfile, fixProfile, marketCatalog, marketInstall, t }) {
	const [request, setRequest] = useState(0);
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(new Set(["core"]));
	const [showSources, setShowSources] = useState(false);
	const [showRescue, setShowRescue] = useState(false);
	const [showMarket, setShowMarket] = useState(false);
	const [busy, setBusy] = useState(null);
	const [feedback, setFeedback] = useState(null);
	const [state, setState] = useState({ status: "loading" });

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
			if (!normalized) return true;
			return entry.configId.toLocaleLowerCase().includes(normalized)
				|| entry.description.toLocaleLowerCase().includes(normalized)
				|| entry.moduleName.toLocaleLowerCase().includes(normalized);
		});
		return NECESSITY_ORDER.map((key) => ({
			key,
			entries: filtered.filter((entry) => entry.necessity === key)
		})).filter((section) => section.entries.length > 0);
	}, [query, state]);

	const updatable = useMemo(() => {
		if (state.status !== "ready") return [];
		return state.snapshot.entries.filter((entry) => entry.needsUpdate === true && entry.managed);
	}, [state]);

	const run = async (key, operation) => {
		setBusy(key);
		setFeedback(null);
		try {
			const result = await operation();
			// list/refresh/getSources/setSources 直接返回快照本体；setEnabled/update 返回
			// { ..., snapshot } 收据结构 —— 统一取快照。
			const snapshot = result?.snapshot ?? result;
			setState({ status: "ready", snapshot });
			return result;
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
			return null;
		} finally {
			setBusy(null);
		}
	};

	const refreshAll = () => run("refresh", () => refresh());

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
		<section aria-label={t("title")} style={{ width: "100%", maxWidth: 880, display: "flex", flexDirection: "column", gap: 10, color: "var(--dsw-alias-label-primary)" }}>
			<header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
				<div>
					<h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t("title")}</h3>
					<p style={{ margin: "2px 0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }}>
						{t("profile")}: <code style={{ fontFamily: "var(--ds-font-family-code)" }}>{snapshot.profileName}</code>
					</p>
				</div>
				<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
					<button type="button" onClick={() => setShowMarket((v) => !v)} disabled={busy !== null}
						style={{ ...buttonStyle, color: "var(--dsw-alias-state-business-primary, #4f8cff)", borderColor: "var(--dsw-alias-state-business-primary, #4f8cff)", fontWeight: showMarket ? 600 : 400 }}>
						{t("market")}
					</button>
					<button type="button" onClick={() => setShowRescue((v) => !v)} disabled={busy !== null}
						style={{ ...buttonStyle, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)", fontWeight: showRescue ? 600 : 400 }}>
						{t("rescue")}
					</button>
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
					<button type="button" onClick={() => setShowSources((v) => !v)} style={{ ...buttonStyle, fontWeight: showSources ? 600 : 400 }}>
						{t("sources")}
					</button>
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
			</div>

			{/* 更新源面板 */}
			{showSources ? <SourcesPanel sources={snapshot.sources} save={saveSources} busy={busy !== null} t={t} /> : null}

			{/* 插件市场（轻量：dshfind 精选目录 + 一键安装） */}
			{showMarket ? <MarketPanel marketCatalog={marketCatalog} marketInstall={marketInstall} busy={busy !== null} t={t} entries={state.status === "ready" ? state.snapshot.entries : []} /> : null}

			{/* 救砖面板 */}
			{showRescue ? <RescuePanel
				diagnose={diagnose}
				quarantine={quarantine}
				repairHarness={repairHarness}
				restartHarness={restartHarness}
				uninstallPackages={uninstallPackages}
				getRescueConfig={getRescueConfig}
				setRescueConfig={setRescueConfig}
				getDownloadConfig={getDownloadConfig}
				checkDownloads={checkDownloads}
				verifyProfile={verifyProfile}
				fixProfile={fixProfile}
				managed={snapshot.entries.filter((entry) => entry.managed)}
				t={t}
			/> : null}

			<label style={{ display: "flex", position: "relative", alignItems: "center" }}>
				<span className="srOnly">{t("search")}</span>
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
							? "color-mix(in srgb, var(--dsw-alias-state-warning-primary) 12%, transparent)"
							: "color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 12%, transparent)",
					color: feedback.severity === "error"
						? "var(--dsw-alias-state-error-primary)"
						: feedback.severity === "warning"
							? "var(--dsw-alias-state-warning-primary)"
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
										background: "color-mix(in srgb, var(--dsw-alias-state-warning-primary) 16%, transparent)",
										color: "var(--dsw-alias-state-warning-primary)",
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
										return (
											<li key={entry.entryId} style={{
												display: "flex",
												alignItems: "center",
												gap: 10,
												padding: "8px 10px",
												border: "1px solid var(--dsw-alias-border-l2)",
												background: "var(--dsw-alias-bg-layer-1)",
												borderRadius: 8,
												minWidth: 0
											}}>
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
													{entry.installedVersion || entry.latestVersion ? (
														<p style={{ margin: "2px 0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 11, fontFamily: "var(--ds-font-family-code)" }}>
															{entry.installedVersion ?? "?"}{entry.latestVersion ? ` → ${entry.latestVersion}` : ""}
															{entry.updateSource ? ` (${entry.updateSource})` : ""}
															{entry.needsUpdate === null && entry.installedVersion ? ` (${t("versionUnknown")})` : ""}
														</p>
													) : null}
												</div>
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
												{canUpdate ? (
													<>
														<button type="button" onClick={() => updateOne(entry)} disabled={busy !== null}
															style={{ ...buttonStyle, flex: "none", fontWeight: 600, color: "var(--dsw-alias-state-warning-primary)", borderColor: "var(--dsw-alias-state-warning-primary)" }}>
															{t("update")}
														</button>
														<button type="button" onClick={() => updateOneInternal(entry)} disabled={busy !== null}
															title={t("updateInternalHint")}
															style={{ ...buttonStyle, flex: "none", fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>
															{t("updateInternal")}
														</button>
													</>
												) : entry.needsUpdate === true && !entry.managed ? (
													<span title={entry.moduleName} style={{ flex: "none", fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>{t("notManaged")}</span>
												) : null}
												{entry.protected ? (
													<span title={entry.protectionReason} style={{ flex: "none", fontSize: 12, opacity: 0.75, cursor: "help" }}>🔒</span>
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
											</li>
										);
									})}
								</ul>
							) : null}
						</section>
					);
				})}
			</div>
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
function RescuePanel({ diagnose, quarantine, repairHarness, restartHarness, uninstallPackages, getRescueConfig, setRescueConfig, getDownloadConfig, checkDownloads, verifyProfile, fixProfile, managed, t }) {
	const [issues, setIssues] = useState(null);
	const [busy, setBusy] = useState(false);
	const [feedback, setFeedback] = useState(null);
	const [auto, setAuto] = useState(false);
	const [dlDir, setDlDir] = useState(null);
	const [verify, setVerify] = useState(null);

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
		if (!window.confirm(`${t("rescueUninstallConfirm")} ${packageName}`)) return;
		setBusy(true);
		try {
			const result = await uninstallPackages([packageName]);
			const item = result.items?.[0];
			setFeedback({ severity: item?.status === "removed" ? "success" : "warning", message: item ? item.message ?? item.status : "完成" });
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(false);
		}
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
				<p role="alert" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", color: feedback.severity === "error" ? "var(--dsw-alias-state-error-primary)" : feedback.severity === "warning" ? "var(--dsw-alias-state-warning-primary)" : "var(--dsw-alias-state-success-primary, #22c55e)" }}>{feedback.message}</p>
			) : null}
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
			{feedback ? <p role="alert" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", color: feedback.severity === "error" ? "var(--dsw-alias-state-error-primary)" : feedback.severity === "warning" ? "var(--dsw-alias-state-warning-primary)" : "var(--dsw-alias-state-success-primary, #22c55e)" }}>{feedback.message}</p> : null}
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
							{source.type === "dshfind" ? <em style={{ fontStyle: "normal", fontSize: 10, color: "var(--dsw-alias-state-warning-primary)", marginLeft: 4 }}>{t("dshfind")}</em> : null}
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
const zh = {
	tab: "插件管理",
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
			refresh: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.refresh(), "检查更新")),
			setEnabled: async (entryId, enabled) => unwrap(await withTimeout(scope.remote.pluginManagerPro.setEnabled(entryId, enabled), "切换插件状态")),
			update: async (packageNames) => unwrap(await withTimeout(scope.remote.pluginManagerPro.update(packageNames), "更新插件")),
			setSources: async (sources) => unwrap(await withTimeout(scope.remote.pluginManagerPro.setSources(sources), "保存更新源")),
			resetToggles: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.resetToggles(), "重置开关")),
			diagnose: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.diagnose(), "诊断")),
			quarantine: async (entryIds) => unwrap(await withTimeout(scope.remote.pluginManagerPro.quarantine(entryIds), "隔离插件")),
			repairHarness: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.repairHarness(), "修复引擎")),
			restartHarness: async () => unwrap(await withTimeout(scope.remote.pluginManagerPro.restartHarness(), "重启引擎")),
			uninstallPackages: async (packageNames) => unwrap(await withTimeout(scope.remote.pluginManagerPro.uninstallPackages(packageNames), "卸载插件")),
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
		scope.slots.inject("settings.plugins.tab", () => scope.slots.register({
			name: "settings.plugins.tab",
			id: "all",
			order: 10,
			label: () => t("tab"),
			locale: NS,
			inject: () => ({ ...api, t })
		}, SafeTab));
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

export { PluginManagerTab, apply, inject, marketFilterItems, entryInstalled };
