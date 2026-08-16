import { z } from "zod";

/**
 * Typert wire contract for the local plugin manager v0.2.
 * Sources + per-source version checks + pnpm-driven updates.
 */
const phase = z.union([
	z.literal(null),
	z.literal("pending"),
	z.literal("loading"),
	z.literal("active"),
	z.literal("failed"),
	z.literal("unloading")
]);

const necessity = z.union([
	z.literal("core"),
	z.literal("recommended"),
	z.literal("optional")
]);

const entry = z.object({
	entryId: z.string(),
	configId: z.string(),
	moduleName: z.string(),
	packageName: z.string(),
	/** 功能简介（简体中文）。 */
	description: z.string(),
	/** 必要程度：core=必须(红) / recommended=推荐(黄) / optional=可选(绿)。 */
	necessity,
	enabled: z.boolean(),
	phase,
	/** 运行期错误（phase=failed 时非空）。 */
	error: z.string().nullable(),
	protected: z.boolean(),
	protectionReason: z.string().nullable(),
	/** 架构保留（web 层刻意禁用、由其它层提供）：禁止开关。 */
	archived: z.boolean(),
	installedVersion: z.string().nullable(),
	/** 所有启用的更新源中可得的最高版本。 */
	latestVersion: z.string().nullable(),
	/** 提供最高版本的源名（无则 null）。 */
	updateSource: z.string().nullable(),
	/** true=可更新；false=已最新；null=无法确认（无启用源/非 npm 包/离线）。 */
	needsUpdate: z.boolean().nullable(),
	/** 是否可由本管理器直接更新（profile 依赖且非 file:/link: 本地包）。 */
	managed: z.boolean()
}).readonly();

const source = z.object({
	name: z.string(),
	url: z.string(),
	enabled: z.boolean(),
	official: z.boolean(),
	/** registry=npm 兼容源；github=GitHub Releases（仓库根 package.json 的 name 匹配包名）。 */
	type: z.union([
		z.literal("registry"),
		z.literal("github")
	])
}).readonly();

const snapshot = z.object({
	profileName: z.string(),
	entries: z.array(entry).readonly(),
	sources: z.array(source).readonly()
}).readonly();

const mutationItem = z.object({
	entryId: z.string(),
	status: z.union([
		z.literal("changed"),
		z.literal("restart-required"),
		z.literal("unchanged"),
		z.literal("skipped"),
		z.literal("failed")
	]),
	message: z.string().nullable()
}).readonly();

const receipt = z.object({
	enabled: z.boolean(),
	items: z.array(mutationItem).readonly(),
	snapshot
}).readonly();

const updateItem = z.object({
	packageName: z.string(),
	status: z.union([
		z.literal("updated"),
		z.literal("failed"),
		z.literal("up-to-date"),
		z.literal("not-managed")
	]),
	message: z.string().nullable(),
	installedVersion: z.string().nullable(),
	latestVersion: z.string().nullable()
}).readonly();

const updateReceipt = z.object({
	items: z.array(updateItem).readonly(),
	snapshot
}).readonly();

/** 诊断问题条目（加载失败/运行期错误）。 */
const diagnoseIssue = z.object({
	entryId: z.string(),
	configId: z.string(),
	moduleName: z.string(),
	phase: z.string().nullable(),
	error: z.string().nullable(),
	/** 建议动作：disable（禁用） / uninstall（卸载） / none。 */
	suggestion: z.union([
		z.literal("disable"),
		z.literal("uninstall"),
		z.literal("none")
	]),
	/** 是否允许卸载（profile 依赖且非本地包）。 */
	canUninstall: z.boolean()
}).readonly();

const diagnoseResult = z.object({
	issues: z.array(diagnoseIssue).readonly(),
	snapshot
}).readonly();

const quarantineItem = z.object({
	entryId: z.string(),
	status: z.union([
		z.literal("disabled"),
		z.literal("failed"),
		z.literal("skipped")
	]),
	message: z.string().nullable()
}).readonly();

const quarantineReceipt = z.object({
	items: z.array(quarantineItem).readonly(),
	snapshot
}).readonly();

const repairAction = z.object({
	action: z.string(),
	detail: z.string()
}).readonly();

const repairResult = z.object({
	actions: z.array(repairAction).readonly(),
	restartCommand: z.string(),
	snapshot
}).readonly();

const restartResult = z.object({
	accepted: z.boolean(),
	message: z.string()
}).readonly();

const uninstallItem = z.object({
	packageName: z.string(),
	status: z.union([
		z.literal("removed"),
		z.literal("failed"),
		z.literal("not-managed")
	]),
	message: z.string().nullable()
}).readonly();

const uninstallReceipt = z.object({
	items: z.array(uninstallItem).readonly(),
	snapshot
}).readonly();

const rescueConfig = z.object({
	autoQuarantine: z.boolean()
}).readonly();

const strict = (typeSymbol, schema) => ({
	mode: "strict",
	typeSymbol,
	schema
});

const parameter = (name, schema) => ({
	name,
	wire: name,
	source: "json",
	codec: strict(`@dsh-local/plugin-manager/types#${name}`, schema)
});

const SNAPSHOT_RESULT_METHODS = new Set(["list", "refresh", "getSources", "setSources", "resetToggles", "setRescueConfig"]);
const RECEIPT_RESULT_METHODS = new Set(["setEnabled", "quarantine", "uninstallPackages", "update"]);
const RESULT_TYPES = {
	diagnose: "PluginManagerDiagnoseResult",
	repairHarness: "PluginManagerRepairResult",
	restartHarness: "PluginManagerRestartResult",
	getRescueConfig: "PluginManagerRescueConfig"
};

const descriptor = (method, parameters, result) => ({
	id: `@dsh-local/plugin-manager#pluginManagerPro/${method}`,
	service: "pluginManagerPro",
	namespace: "pluginManagerPro",
	method,
	invocation: { kind: "direct" },
	parameters,
	result: strict(`@dsh-local/plugin-manager/types#${SNAPSHOT_RESULT_METHODS.has(method) ? "PluginManagerSnapshot" : RECEIPT_RESULT_METHODS.has(method) ? method === "quarantine" ? "PluginManagerQuarantineReceipt" : method === "uninstallPackages" ? "PluginManagerUninstallReceipt" : "PluginManagerMutationReceipt" : RESULT_TYPES[method] ?? "PluginManagerMutationReceipt"}`, result)
});

const descriptors = [
	descriptor("list", [], snapshot),
	descriptor("refresh", [], snapshot),
	descriptor("getSources", [], snapshot),
	descriptor("setSources", [parameter("sources", z.array(source))], snapshot),
	descriptor("setEnabled", [parameter("entryId", z.string()), parameter("enabled", z.boolean())], receipt),
	descriptor("resetToggles", [], snapshot),
	descriptor("update", [parameter("packageNames", z.array(z.string()))], updateReceipt),
	// —— 救砖 ——
	descriptor("diagnose", [], diagnoseResult),
	descriptor("quarantine", [parameter("entryIds", z.array(z.string()))], quarantineReceipt),
	descriptor("repairHarness", [], repairResult),
	descriptor("restartHarness", [], restartResult),
	descriptor("uninstallPackages", [parameter("packageNames", z.array(z.string()))], uninstallReceipt),
	descriptor("getRescueConfig", [], rescueConfig),
	descriptor("setRescueConfig", [parameter("config", rescueConfig)], snapshot)
];

const TYPERT_REMOTE = {
	package: "@dsh-local/plugin-manager",
	descriptors
};

/** Host Typert artifact loaded from the package's `./typert` export. */
const TYPERT = {
	package: "@dsh-local/plugin-manager",
	face: "host",
	schemas: [],
	invocations: descriptors,
	model: {
		services: [],
		events: [],
		objects: []
	}
};

export { TYPERT, TYPERT_REMOTE, TYPERT_REMOTE as default };
