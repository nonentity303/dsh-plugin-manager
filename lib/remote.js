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
	/** 来源：builtin=架构自带（随 dsh 提供）；user=用户/agent 通过 dsh plugin add / 市场安装。 */
	origin: z.union([
		z.literal("builtin"),
		z.literal("user")
	]),
	/** 来源标签（人工修正优先）：builtin=随 dsh 提供 / local=本地包 / github=仓库声明 GitHub / npm=默认 registry。 */
	source: z.union([
		z.literal("builtin"),
		z.literal("local"),
		z.literal("github"),
		z.literal("npm")
	]),
	/** 用户手动覆盖的来源标签（无则 null，显示为自动判定）。 */
	sourceOverride: z.union([
		z.literal("builtin"),
		z.literal("local"),
		z.literal("github"),
		z.literal("npm")
	]).nullable(),
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
	/** registry=npm 兼容源；github=GitHub Releases；dshfind=插件超市（GitHub dsh-plugin topic 聚合）。 */
	type: z.union([
		z.literal("registry"),
		z.literal("github"),
		z.literal("dshfind")
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

/** L9：卸载管理器自身前的开机自启清理结果（调用包内 `bin/open-boot.mjs --uninstall`）。 */
const autostartCleanupResult = z.object({
	/** cleaned=exit 0 完成 / skipped=包内无该命令（旧版本）/ failed=非 0 退出 / timeout=超时被终止。 */
	status: z.union([
		z.literal("cleaned"),
		z.literal("skipped"),
		z.literal("failed"),
		z.literal("timeout")
	]),
	/** 子进程退出码（skipped/timeout 时为 null）。 */
	exitCode: z.number().nullable(),
	message: z.string(),
	/** 实际执行的命令行（skipped 时为 null）。 */
	command: z.string().nullable()
}).readonly();

const uninstallItem = z.object({
	packageName: z.string(),
	status: z.union([
		z.literal("removed"),
		z.literal("rolled-back"),
		z.literal("failed"),
		z.literal("not-managed")
	]),
	message: z.string().nullable(),
	/** 本事务实际移除的包名（级联时多于目标包）。 */
	affectedEntries: z.array(z.string()).readonly(),
	/** 清理的管理器开关行数。 */
	removedPatchRows: z.number(),
	/** 级联卸载的依赖包。 */
	dependentPackages: z.array(z.string()).readonly(),
	/** 卸载后启动前自检结果（null=未执行）。 */
	verifyOk: z.boolean().nullable(),
	/** 删除失败的残留目录（下次启动自动重试）。 */
	residuals: z.array(z.string()).readonly(),
	/** package.json 备份路径（撤销用）。 */
	backupPath: z.string().nullable(),
	/** 本次事务是否包含管理器自身（L9：移除前会先清理开机自启）。 */
	isSelf: z.boolean(),
	/** L9：开机自启清理结果（不含管理器自身时为 null）。 */
	autostartCleanup: autostartCleanupResult.nullable()
}).readonly();

const uninstallReceipt = z.object({
	items: z.array(uninstallItem).readonly(),
	snapshot
}).readonly();

/** 卸载影响预览（建议二：变更预览 —— 展示影响范围，用户确认后才执行）。 */
const uninstallAffectedEntry = z.object({
	configId: z.string(),
	moduleName: z.string(),
	enabled: z.boolean()
}).readonly();

const uninstallDependent = z.object({
	packageName: z.string(),
	/** dependencies / peerDependencies / optionalDependencies。 */
	type: z.string(),
	spec: z.string()
}).readonly();

/**
 * P1-4 卸载前体检条目（全部只读，不改动 profile 任何文件）。
 * severity 分级：high=高风险（依赖断裂）/ warning=提示（patch 残留、唯一 service） / info=信息（重复 service·端口）。
 */
const uninstallCheck = z.object({
	/** dependency-break / patch-residue / duplicate-service / duplicate-port / unique-service / unique-port / self-uninstall。 */
	id: z.string(),
	severity: z.union([
		z.literal("info"),
		z.literal("warning"),
		z.literal("high")
	]),
	/** 一行摘要（如「dsh-free-search 依赖 dsh-foo」）。 */
	title: z.string(),
	/** 细节与降级/升级理由。 */
	detail: z.string()
}).readonly();

/** P1-4 体检结论：safe=安全 / caution=需注意 / risky=有风险。 */
const uninstallVerdict = z.union([
	z.literal("safe"),
	z.literal("caution"),
	z.literal("risky")
]);

/** L9：开机自启清理结果（schema 定义见上方 `autostartCleanupResult`，此处仅用于预览/收据引用）。 */
const uninstallPreviewItem = z.object({
	packageName: z.string(),
	spec: z.string().nullable(),
	/** 是否在 dsh.profile.bundles 中（会移除 bundle 声明）。 */
	inBundles: z.boolean(),
	/** 将清理的管理器开关行数。 */
	patchRows: z.number(),
	/** 将随之消失的 loader 条目。 */
	affectedEntries: z.array(uninstallAffectedEntry).readonly(),
	/** 依赖该包的已安装包（卸载会造成依赖断裂）。 */
	dependents: z.array(uninstallDependent).readonly(),
	/** 是否管理器自身（卸载前会先清理开机自启，见 autostartCleanup）。 */
	isSelf: z.boolean(),
	/** P1-4 三类体检条目（依赖断裂 / patch 残留 / 重复 service·端口）。 */
	checks: z.array(uninstallCheck).readonly(),
	/** 体检结论（safe/caution/risky）。 */
	verdict: uninstallVerdict,
	/** 一句理由（结论行的副标题）。 */
	verdictReason: z.string(),
	canUninstall: z.boolean()
}).readonly();

const uninstallPreviewResult = z.object({
	packages: z.array(uninstallPreviewItem).readonly()
}).readonly();

/** 卸载选项：cascade=级联卸载依赖该包的可卸载包。 */
const uninstallOptions = z.object({
	cascade: z.boolean().default(false)
}).readonly();

/** 操作历史（建议二：最近 N 次操作 + 一键撤销）。 */
const historyChange = z.object({
	configId: z.string(),
	moduleName: z.string(),
	enabled: z.boolean()
}).readonly();

const historyUndo = z.object({
	type: z.union([
		z.literal("restore-files"),
		z.literal("patch-state")
	]),
	manifest: z.string().nullable(),
	patch: z.string().nullable(),
	packageName: z.string().nullable(),
	spec: z.string().nullable(),
	changes: z.array(historyChange).readonly()
}).readonly();

const historyItem = z.object({
	id: z.string(),
	at: z.string(),
	action: z.string(),
	label: z.string(),
	detail: z.string().nullable(),
	result: z.union([
		z.literal("ok"),
		z.literal("failed")
	]),
	undone: z.boolean(),
	undo: historyUndo.nullable()
}).readonly();

const historyResult = z.object({
	operations: z.array(historyItem).readonly()
}).readonly();

const undoResult = z.object({
	ok: z.boolean(),
	message: z.string(),
	snapshot
}).readonly();

/** 场景方案（建议五：保存/应用插件组合，一键切换）。 */
const scenario = z.object({
	id: z.string(),
	name: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
	/** configId -> 期望启用状态。 */
	states: z.record(z.string(), z.boolean()),
	/** 启停计数（服务端投影）。 */
	counts: z.object({
		enabled: z.number(),
		disabled: z.number()
	})
}).readonly();

const scenarioListResult = z.object({
	scenarios: z.array(scenario).readonly()
}).readonly();

/** 场景切换逐条结果（dryRun 时 status=null，只表示"将会变更"）。 */
const scenarioDiff = z.object({
	configId: z.string(),
	moduleName: z.string(),
	/** 场景目标状态。 */
	enabled: z.boolean(),
	/** 当前运行状态。 */
	current: z.boolean(),
	// changed=true 时表示与该场景不一致（会被切换/已切换）
	changed: z.boolean(),
	protected: z.boolean(),
	/** 保护原因（protected=true 时非空）/失败原因/跳过原因。 */
	reason: z.string().nullable(),
	status: z.union([
		z.literal("none"),
		z.literal("changed"),
		z.literal("skipped"),
		z.literal("failed")
	]).nullable()
}).readonly();

const scenarioApplyResult = z.object({
	items: z.array(scenarioDiff).readonly(),
	scenarios: z.array(scenario).readonly(),
	snapshot
}).readonly();

const rescueConfig = z.object({
	autoQuarantine: z.boolean()
}).readonly();

/** 下载目录配置。 */
const downloadConfig = z.object({
	dir: z.string()
}).readonly();

/** 下载目录拾取结果。 */
const checkDownloadsItem = z.object({
	name: z.string(),
	message: z.string().nullable()
}).readonly();

const checkDownloadsResult = z.object({
	installed: z.array(z.string()).readonly(),
	failed: z.array(checkDownloadsItem).readonly(),
	message: z.string().nullable()
}).readonly();

/** 手动下载链接解析结果。 */
const downloadUrlResult = z.object({
	url: z.string().nullable(),
	message: z.string().nullable(),
	sourceName: z.string().nullable(),
	installedVersion: z.string().nullable(),
	latestVersion: z.string().nullable()
}).readonly();

/** 浏览器下载模式条目（管理器触发浏览器下载，落盘后自动拾取安装）。 */
const browserItem = z.object({
	packageName: z.string(),
	status: z.union([
		z.literal("need-download"),
		z.literal("up-to-date"),
		z.literal("not-managed"),
		z.literal("failed")
	]),
	url: z.string().nullable(),
	sourceName: z.string().nullable(),
	installedVersion: z.string().nullable(),
	latestVersion: z.string().nullable(),
	message: z.string().nullable()
}).readonly();

const browserReceipt = z.object({
	items: z.array(browserItem).readonly(),
	snapshot
}).readonly();

/** 启动前自检（bundles/patch 可解析性）。 */
const profileIssue = z.object({
	kind: z.string(),
	name: z.string(),
	reason: z.string()
}).readonly();

const verifyResult = z.object({
	ok: z.boolean(),
	issues: z.array(profileIssue).readonly()
}).readonly();

const fixResult = z.object({
	ok: z.boolean(),
	actions: z.array(repairAction).readonly(),
	message: z.string().nullable()
}).readonly();

/** 市场安装目标（客户端从目录条目选取，host 侧再做白名单/校验）。 */
const marketTarget = z.object({
	/** 条目名（目录中的展示名）。 */
	name: z.string(),
	/** npm 包名（目录条目声明时可用，优先走 registry 安装）。 */
	npm: z.string().nullable(),
	/** 仓库主页（github.com/owner/repo）。 */
	url: z.string()
}).readonly();

/** 插件市场目录条目（来自 awesome-dsh-plugin 精选目录，或 GitHub 搜索兜底）。 */
const marketItem = z.object({
	name: z.string(),
	owner: z.string(),
	url: z.string(),
	/** 目录条目声明的 npm 包名（registry 安装优先）；无则 null。 */
	npm: z.string().nullable(),
	/** 分类 id（"market"/"theme"/"utility"…，GitHub 兜底时为 "github"）。 */
	category: z.string(),
	/** 本地化描述：语言代码 -> 文本（可能只有 en）。 */
	description: z.record(z.string(), z.string().nullable()).nullable(),
	stars: z.number().nullable(),
	/** 收录日期（YYYY-MM-DD，GitHub 兜底时为更新时间）。 */
	added: z.string().nullable()
}).readonly();

const marketCatalogResult = z.object({
	/** live=在线目录 / cache=内存缓存 / github-fallback=GitHub 搜索兜底 / error=全部失败。 */
	source: z.string(),
	updated: z.string().nullable(),
	count: z.number(),
	/** 分类 id -> {zh, en}（GitHub 兜底时为 null）。 */
	categories: z.record(z.string(), z.record(z.string(), z.string())).nullable(),
	items: z.array(marketItem).readonly()
}).readonly();

/** 市场一键安装结果。 */
const marketInstallResult = z.object({
	status: z.union([
		z.literal("installed"),
		z.literal("dry-run"),
		z.literal("failed"),
		z.literal("already-installed")
	]),
	packageName: z.string().nullable(),
	url: z.string().nullable(),
	/** 安装方式：npm=registry 直装 / github=GitHub 下载 / null=未到达安装阶段。 */
	method: z.string().nullable(),
	message: z.string().nullable()
}).readonly();

/**
 * 构造 strict codec。两个字段并存以同时兼容两代引擎的 typert-loader 校验：
 * - 0.1.1-rc.2 及更早：读 `schema`（要求是 zod schema）
 * - 0.1.7-rc.2 起：读 `create`（要求是零参、返回 schema 的工厂函数；旧 `schema` 字段已不再读取）
 * 两版校验器都只做正向字段断言、不拒绝多余字段，所以双写是安全的过渡写法。
 */
const strict = (typeSymbol, schema) => ({
	mode: "strict",
	typeSymbol,
	schema,
	create: () => schema
});

const parameter = (name, schema) => ({
	name,
	wire: name,
	source: "json",
	codec: strict(`dsh-plugin-manager-pro/types#${name}`, schema)
});

const SNAPSHOT_RESULT_METHODS = new Set(["list", "refresh", "getSources", "setSources", "resetToggles", "setRescueConfig", "setSourceOverride"]);
const RECEIPT_RESULT_METHODS = new Set(["setEnabled", "quarantine", "uninstallPackages", "update"]);
const RESULT_TYPES = {
	diagnose: "PluginManagerDiagnoseResult",
	repairHarness: "PluginManagerRepairResult",
	restartHarness: "PluginManagerRestartResult",
	getRescueConfig: "PluginManagerRescueConfig",
	getDownloadConfig: "PluginManagerDownloadConfig",
	checkDownloads: "PluginManagerCheckDownloadsResult",
	resolveDownloadUrl: "PluginManagerDownloadUrlResult",
	verifyProfile: "PluginManagerVerifyResult",
	fixProfile: "PluginManagerFixResult",
	updateBrowser: "PluginManagerBrowserReceipt",
	marketCatalog: "PluginManagerMarketCatalogResult",
	marketInstall: "PluginManagerMarketInstallResult",
	uninstallPreview: "PluginManagerUninstallPreviewResult",
	operationHistory: "PluginManagerHistoryResult",
	undoOperation: "PluginManagerUndoResult",
	scenarioList: "PluginManagerScenarioListResult",
	scenarioSave: "PluginManagerScenarioListResult",
	scenarioUpdate: "PluginManagerScenarioListResult",
	scenarioDelete: "PluginManagerScenarioListResult",
	scenarioApply: "PluginManagerScenarioApplyResult"
};

const descriptor = (method, parameters, result) => ({
	id: `dsh-plugin-manager-pro#pluginManagerPro/${method}`,
	service: "pluginManagerPro",
	namespace: "pluginManagerPro",
	method,
	invocation: { kind: "direct" },
	parameters,
	result: strict(`dsh-plugin-manager-pro/types#${SNAPSHOT_RESULT_METHODS.has(method) ? "PluginManagerSnapshot" : RECEIPT_RESULT_METHODS.has(method) ? method === "quarantine" ? "PluginManagerQuarantineReceipt" : method === "uninstallPackages" ? "PluginManagerUninstallReceipt" : "PluginManagerMutationReceipt" : RESULT_TYPES[method] ?? "PluginManagerMutationReceipt"}`, result)
});

const descriptors = [
	descriptor("list", [], snapshot),
	descriptor("refresh", [], snapshot),
	descriptor("getSources", [], snapshot),
	descriptor("setSources", [parameter("sources", z.array(source))], snapshot),
	descriptor("setEnabled", [parameter("entryId", z.string()), parameter("enabled", z.boolean())], receipt),
	descriptor("resetToggles", [], snapshot),
	descriptor("update", [parameter("packageNames", z.array(z.string()))], updateReceipt),
	// —— 救砖 / 事务化卸载 ——
	descriptor("diagnose", [], diagnoseResult),
	descriptor("quarantine", [parameter("entryIds", z.array(z.string()))], quarantineReceipt),
	descriptor("repairHarness", [], repairResult),
	descriptor("restartHarness", [], restartResult),
	descriptor("uninstallPackages", [parameter("packageNames", z.array(z.string())), parameter("options", uninstallOptions)], uninstallReceipt),
	descriptor("uninstallPreview", [parameter("packageNames", z.array(z.string()))], uninstallPreviewResult),
	// —— 操作历史 / 撤销 ——
	descriptor("operationHistory", [], historyResult),
	descriptor("undoOperation", [parameter("id", z.string())], undoResult),
	// —— 来源人工修正 / 场景方案 ——
	descriptor("setSourceOverride", [parameter("packageName", z.string()), parameter("source", z.string().nullable())], snapshot),
	descriptor("scenarioList", [], scenarioListResult),
	descriptor("scenarioSave", [parameter("name", z.string())], scenarioListResult),
	descriptor("scenarioUpdate", [parameter("id", z.string())], scenarioListResult),
	descriptor("scenarioDelete", [parameter("id", z.string())], scenarioListResult),
	descriptor("scenarioApply", [parameter("id", z.string()), parameter("dryRun", z.boolean())], scenarioApplyResult),
	descriptor("getRescueConfig", [], rescueConfig),
	descriptor("setRescueConfig", [parameter("config", rescueConfig)], snapshot),
	// —— 下载目录与启动前自检 ——
	descriptor("getDownloadConfig", [], downloadConfig),
	descriptor("checkDownloads", [], checkDownloadsResult),
	descriptor("resolveDownloadUrl", [parameter("packageName", z.string())], downloadUrlResult),
	descriptor("verifyProfile", [], verifyResult),
	descriptor("fixProfile", [], fixResult),
	descriptor("updateBrowser", [parameter("packageNames", z.array(z.string()))], browserReceipt),
	descriptor("marketCatalog", [], marketCatalogResult),
	descriptor("marketInstall", [parameter("target", marketTarget), parameter("dryRun", z.boolean())], marketInstallResult)
];

const TYPERT_REMOTE = {
	package: "dsh-plugin-manager-pro",
	descriptors
};

/** Host Typert artifact loaded from the package's `./typert` export. */
const TYPERT = {
	package: "dsh-plugin-manager-pro",
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
