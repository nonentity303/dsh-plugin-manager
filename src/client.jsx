import React, { useEffect, useMemo, useState } from "react";

/**
 * 插件管理器 —— 浏览器端（打包产物 lib/client.js 由客户端模块系统经
 * /plugins/<id>/client.js 提供）。
 *
 * 界面：插件名称 / 功能简介 / 必要程度（红=必须 黄=推荐 绿=可选）/
 * 启用状态（红=错误·需检查 黄=需更新 灰=未启用 绿=启用）/ 开关按键。
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

/** 状态优先：错误(红) > 需更新(黄) > 未启用(灰)/启用(绿)。 */
function statusOf(entry) {
	if (entry.phase === "failed" || entry.error) return "error";
	if (entry.needsUpdate === true) return "update";
	return entry.enabled ? "enabled" : "disabled";
}

function PluginManagerTab({ list, refresh, setEnabled, t }) {
	const [request, setRequest] = useState(0);
	const [query, setQuery] = useState("");
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

	const rows = useMemo(() => {
		if (state.status !== "ready") return [];
		const normalized = query.trim().toLocaleLowerCase();
		return state.snapshot.entries.filter((entry) => {
			if (!normalized) return true;
			return entry.configId.toLocaleLowerCase().includes(normalized)
				|| entry.description.toLocaleLowerCase().includes(normalized)
				|| entry.moduleName.toLocaleLowerCase().includes(normalized);
		});
	}, [query, state]);

	const refreshAll = () => {
		setFeedback(null);
		setBusy("refresh");
		refresh().then((snapshot) => {
			setState({ status: "ready", snapshot });
		}, (error) => {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		}).finally(() => setBusy(null));
	};

	const toggle = async (entry) => {
		setBusy(entry.entryId);
		setFeedback(null);
		try {
			const receipt = await setEnabled(entry.entryId, !entry.enabled);
			setState({ status: "ready", snapshot: receipt.snapshot });
			const failed = receipt.items.filter((item) => item.status === "failed").map((item) => item.message).filter(Boolean).join(" ");
			const restart = receipt.items.filter((item) => item.status === "restart-required").map((item) => item.message).filter(Boolean).join(" ");
			if (failed) setFeedback({ severity: "error", message: failed });
			else if (restart) setFeedback({ severity: "warning", message: restart });
		} catch (error) {
			setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(null);
		}
	};

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

	return (
		<section aria-label={t("title")} style={{ width: "100%", maxWidth: 860, display: "flex", flexDirection: "column", gap: 12, color: "var(--dsw-alias-label-primary)" }}>
			<header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
				<div>
					<h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t("title")}</h3>
					<p style={{ margin: "2px 0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }}>
						{t("profile")}: <code style={{ fontFamily: "var(--ds-font-family-code)" }}>{state.snapshot.profileName}</code>
					</p>
				</div>
				<button type="button" aria-label={t("refresh")} title={t("refresh")} onClick={refreshAll} disabled={busy === "refresh"} style={{ ...buttonStyle, width: 32, height: 32, display: "grid", placeItems: "center" }}>
					{busy === "refresh" ? "…" : "↻"}
				</button>
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
						height: 36,
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

			{state.snapshot.entries.length === 0 ? <p style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 13 }}>{t("empty")}</p> : null}
			{state.snapshot.entries.length > 0 && rows.length === 0 ? <p style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 13 }}>{t("emptySearch")}</p> : null}

			{feedback ? (
				<p role={feedback.severity === "error" ? "alert" : "status"} style={{
					margin: 0,
					fontSize: 12,
					lineHeight: "18px",
					padding: "6px 10px",
					borderRadius: 6,
					background: feedback.severity === "error"
						? "color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)"
						: "color-mix(in srgb, var(--dsw-alias-state-warning-primary) 12%, transparent)",
					color: feedback.severity === "error"
						? "var(--dsw-alias-state-error-primary)"
						: "var(--dsw-alias-state-warning-primary)"
				}}>
					{feedback.message}
				</p>
			) : null}

			<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
				{rows.map((entry) => {
					const status = statusOf(entry);
					const statusMeta = STATUS_META[status];
					const necessityMeta = NECESSITY_META[entry.necessity] ?? NECESSITY_META.recommended;
					const running = busy === entry.entryId;
					return (
						<li key={entry.entryId} style={{
							display: "flex",
							alignItems: "center",
							gap: 10,
							padding: "8px 10px",
							border: "1px solid var(--dsw-alias-border-l2)",
							background: "var(--dsw-alias-bg-layer-3)",
							borderRadius: 8,
							minWidth: 0
						}}>
							{/* 启用状态（红/黄/灰/绿） */}
							<span title={entry.error ?? undefined} style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none", width: 86, fontSize: 12, color: statusMeta.color }}>
								<i style={{ width: 9, height: 9, borderRadius: "50%", background: statusMeta.color, display: "inline-block", flex: "none" }} />
								{t(statusMeta.key)}
							</span>
							{/* 名称 + 简介 */}
							<div style={{ flex: "1 1 auto", minWidth: 0 }}>
								<div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
									<strong style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.configId}</strong>
									<span style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.moduleName}</span>
								</div>
								<p style={{ margin: "2px 0 0", color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px" }}>{entry.description}</p>
								{entry.installedVersion || entry.latestVersion ? (
									<p style={{ margin: "2px 0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 11, fontFamily: "var(--ds-font-family-code)" }}>
										{entry.installedVersion ?? "?"}{entry.latestVersion ? ` → ${entry.latestVersion}` : ""}
										{entry.needsUpdate === null && entry.installedVersion ? ` (${t("versionUnknown")})` : ""}
									</p>
								) : null}
							</div>
							{/* 必要程度（红/黄/绿） */}
							<span style={{
								flex: "none",
								fontSize: 11,
								fontWeight: 600,
								padding: "2px 8px",
								borderRadius: 999,
								border: `1px solid ${necessityMeta.color}`,
								color: necessityMeta.color
							}}>
								{t(necessityMeta.key)}
							</span>
							{/* 开关按键 */}
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
		</section>
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

/** 本地化文案。 */
const zh = {
	tab: "插件管理",
	title: "插件管理",
	profile: "当前配置",
	search: "搜索插件名称/简介/包名",
	refresh: "刷新并重新检测版本",
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
	versionUnknown: "版本未知"
};

const en = {
	tab: "Plugin manager",
	title: "Plugin manager",
	profile: "Active profile",
	search: "Search by name, description or package",
	refresh: "Refresh and re-check versions",
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
	versionUnknown: "version unknown"
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
		const api = {
			list: async () => unwrap(await scope.remote.pluginManagerPro.list()),
			refresh: async () => unwrap(await scope.remote.pluginManagerPro.refresh()),
			setEnabled: async (entryId, enabled) => unwrap(await scope.remote.pluginManagerPro.setEnabled(entryId, enabled))
		};
		scope.slots.inject("settings.plugins.tab", () => scope.slots.register({
			name: "settings.plugins.tab",
			id: "all",
			order: 10,
			label: () => t("tab"),
			locale: NS,
			inject: () => ({ ...api, t })
		}, PluginManagerTab));
	});
	return async () => {
		await feature.dispose();
		disposeLocale();
		await disposeRemote();
	};
}

export { PluginManagerTab, apply, inject };
