/**
 * rescue-profile.mjs — S5：救援 profile（**官方通道**）+ 官方恢复之后的**自愈**。
 *
 * 两个一手事实（1.1.0 设计契约 F5 / F6、红线第 1/2 条）：
 *
 *  F5 官方 `PROFILE_TEMPLATES` 只有 acp/web/headless/sdk/sdk-minimal，**没有 rescue**；
 *     但官方 CLI help 自己举的例子是
 *         dsh rescue --from-default-profile web
 *         recreate rescue from the shipped web template, then boot it
 *     → 「从出厂 web 模板造一个救援 profile」是**官方推荐用法**，`rescue` 只是一个**自定义 profile 名**
 *       （`dsh <name>` 等价于 `dsh --profile <name>`；`--from-default-profile` 只在自定义名下可用，
 *        官方保留名会被拒："names shipped profile ... and cannot be a custom profile target"）。
 *     所以 drydock 的救援链完全走官方通道：**不碰 desktop profile、不需要绕 `rejectElectronProfile`**。
 *
 *  F6 桌面官方恢复（致命故障对话框里"禁用第三方插件、备份 profile patch 并重启"）=
 *     禁用第三方 bundle + 把 `cordis.patch.yml` **改名 `cordis.patch.yml.bak-<timestamp>`** +
 *     下次启动建**空 patch**；已装包与备份保留。
 *     → 官方救活了引擎，同时把 drydock 的运维层一起埋了（归属行 / 开关行 / 隔离行全丢）。
 *     → drydock 独有落点：**恢复后自愈** —— 从侧车 `plugin-manager.json` + `.rescue-bak-*` 备份
 *       按三分区（核心 / 内置锁定保留、第三方逐个加回并复检）重建归属行。
 *       也就是：**它修这次启动，我们修下一次为什么还会坏。**
 *
 * 本模块纪律：
 *  - **纯 Node 读写**（无新依赖）；fs 可注入（`fsx`），spawn 可注入（`run`），便于单测。
 *  - **桌面场景绝不 spawn / kill Host**（红线 2）；desktop profile 只用纯 Node 文件读写。
 *  - **绝不** `dsh plugin --profile desktop`（会被 `rejectElectronProfile` 拒绝）。
 *  - 分级授权：`profiles/desktop/lock` 存在 → 拒绝写盘并给只读预览；
 *    desktop 未持锁 → 只做 `cordis.patch.yml` 级**可逆**写（写前备份 + 只动带归属标记的行）+ 必须显式 `confirm`；
 *    web profile → 行为与现状一致（不受影响）。
 *  - `dryRun` **默认 true**（安全默认），必须显式 `dryRun:false` 才写。
 *  - **BOM 防护**：读 patch / JSON 遇 UTF-8 BOM 必须**报告并剥离**；写盘一律无 BOM。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";

//#region 常量（与 lib/index.js、lib/preflight.mjs 保持同一份字面量；此处自带一份，避免跨模块耦合）
export const PATCH_FILENAME = "cordis.patch.yml";
export const SIDECAR_FILENAME = "plugin-manager.json";
export const MANIFEST_FILENAME = "package.json";
export const LOCK_FILENAME = "lock";
export const OWNER_MARKER = "Managed by dsh-drydock. Remove this row to return control to higher-level configuration.";
export const LEGACY_OWNER_MARKERS = ["Managed by dsh-plugin-manager-pro"];
/** 官方 help 里的示例名（`dsh rescue --from-default-profile web`）。 */
export const RESCUE_PROFILE_NAME = "rescue";
/** 官方 help 里的示例模板名。 */
export const DEFAULT_TEMPLATE = "web";

/**
 * 官方 `PROFILE_TEMPLATES` 的**静态回落副本**（F5，取自已装 `@deepseek-ai/dsh-official-bundles`）。
 * 能动态 import 到官方包时以官方为准（见 `resolveKnownTemplates`）。
 */
export const STATIC_PROFILE_TEMPLATES = ["acp", "headless", "sdk", "sdk-minimal", "web"];

/** 官方 `HIDDEN_BUNDLES`：内置 profile bundle（没有插件页、由出厂模板提供）。 */
export const STATIC_HIDDEN_BUNDLES = new Set([
	"@deepseek-ai/dsh-base",
	"@deepseek-ai/dsh-web-app",
	"@deepseek-ai/dsh-headless",
	"@deepseek-ai/dsh-sdk-app",
	"@deepseek-ai/dsh-acp-app",
	"@deepseek-ai/dsh-sdk-minimal",
	"@deepseek-ai/dsh-experimental-terminal-bundle",
	"@deepseek-ai/dsh-experimental-tool-worktree"
]);

/** 官方 `PROTECTED_PLUGINS`：管理自身必需，插件管理器拒绝停用/卸载。 */
export const STATIC_PROTECTED_PLUGINS = new Set([
	"@deepseek-ai/dsh-plugin-manager",
	"@deepseek-ai/cordis-plugin-loader",
	"@deepseek-ai/cordis-plugin-include",
	"@deepseek-ai/dsh-api-gateway",
	"@deepseek-ai/dsh-host-webserver",
	"@deepseek-ai/dsh-client-modules",
	"@deepseek-ai/dsh-client-ui-settings-plugin-inventory",
	"@deepseek-ai/dsh-client-ui-plugin-manager",
	"@deepseek-ai/dsh-host-plugin-inventory",
	"@deepseek-ai/dsh-typert-registry",
	"@deepseek-ai/dsh-api-remotes",
	"@deepseek-ai/dsh-api-remote-access",
	"@deepseek-ai/cordis-plugin-timer",
	"@deepseek-ai/dsh-client-connection",
	"@deepseek-ai/dsh-host-frontend-static",
	"@deepseek-ai/dsh-tools",
	"@deepseek-ai/dsh-hmr"
]);

/**
 * 核心 / 架构保留 configId（与 lib/index.js 的 `RESCUE_NEVER` + `ARCHIVED_IDS` +
 * `UI_CRITICAL_IDS` + `DEFAULT_PROTECTED_IDS` 对齐）：这些条目由引擎自身提供，
 * drydock 只允许"开关"，**自愈时绝不为它们重建 patch 行**（写了会和引擎/模板层重复）。
 */
export const CORE_CONFIG_IDS = new Set([
	// RESCUE_NEVER：救援必需
	"drydock", "timer", "include", "hmr", "loader", "webserver", "web-runtime", "web-startup",
	"connection", "client-runtime", "client-modules", "modules", "locale", "api-gateway",
	"typert", "typert-loader", "typert-gateway", "session", "agent", "agent-loop", "llm",
	// ARCHIVED_IDS：架构保留（由浏览器端/其它层提供）
	"tool-bash", "tool-pwsh", "tool-jobs", "tool-fs", "tool-fs-search", "agent-instructions",
	"skill-filesystem", "skill-badge", "tool-skill", "plan-mode", "compaction-basic",
	"command-compact", "tool-subagent-control", "tool-subagent-list-agents", "tool-subagent",
	"tool-subagent-fork", "workflow-worker-thread", "tool-workflow", "tool-result-pruner",
	"tool-todo", "tool-goal", "tool-ralph", "tool-str-replace-editor", "tool-web", "bash-sandbox",
	"client-hmr", "session-telemetry-otel", "ui-settings-plugin-inventory",
	// UI_CRITICAL_IDS：界面骨架
	"client-connection", "ui-layout", "ui-sidebar", "ui-conversation", "ui-theme", "ui-cordis",
	"ui-tool", "ui-input-trigger", "ui-workspace", "ui-commands", "ui-settings-models", "ui-permission",
	// DEFAULT_PROTECTED_IDS
	"api-remotes", "client-locale", "cordis-host-runner", "runtime", "ui-settings",
	"ui-settings-general", "ui-settings-plugins"
]);

/** 官方恢复留下的 patch 备份：`cordis.patch.yml.bak-<timestamp>`（F6）。 */
const RECOVERY_BAK_RE = /^cordis\.patch\.yml\.bak-(.+)$/i;
/** drydock 自己的写前备份：`cordis.patch.yml.rescue-bak-<timestamp>`（现有约定）。 */
const DRYDOCK_BAK_RE = /^cordis\.patch\.yml\.rescue-bak-(.+)$/i;
/** drydock 改 package.json 前的备份：`package.json.rescue-bak-<timestamp>`。 */
const MANIFEST_BAK_RE = /^package\.json\.rescue-bak-(.+)$/i;
//#endregion

//#region 基础工具（fs 可注入 / BOM / 行解析）
const BOM_CHAR = "\uFEFF";

const NODE_FS = { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync };

/** 合并注入的 fs（只接受函数字段；默认 node:fs）。 */
function fsAdapter(fsx) {
	const f = { ...NODE_FS };
	if (fsx !== null && typeof fsx === "object") {
		for (const [key, value] of Object.entries(fsx)) if (typeof value === "function") f[key] = value;
	}
	return f;
}

/** 剥离 UTF-8 BOM 并**报告**（契约：不静默）。 */
export function stripBom(text) {
	if (typeof text !== "string") return { text: "", hadBom: false };
	return text.startsWith(BOM_CHAR) ? { text: text.slice(1), hadBom: true } : { text, hadBom: false };
}

/** 读文本文件：BOM 一律剥离并报告；失败给机器可读 code。 */
function readTextFile(f, path) {
	try {
		const raw = String(f.readFileSync(path, "utf8"));
		const { text, hadBom } = stripBom(raw);
		return { ok: true, text, raw, hadBom, bytes: Buffer.byteLength(raw, "utf8") };
	} catch (error) {
		return { ok: false, code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) };
	}
}

function ownedComment(comment) {
	if (typeof comment !== "string") return false;
	if (comment.includes("Managed by dsh-drydock")) return true;
	return LEGACY_OWNER_MARKERS.some((marker) => comment.includes(marker));
}

/**
 * 把 YAML map 节点取成纯 JS（深）。
 * yaml 2.x 的 `Node.toJS()` **必须传 document**（不传抛 "A document argument is required"），
 * 而 `Node.toJSON()` 不需要文档 —— 所以统一走 `toJSON()`，拿不到再试 `toJS(doc)`。
 */
function nodeToJs(node, doc = null) {
	try {
		const js = node.toJSON();
		if (js !== null && typeof js === "object") return js;
	} catch { /* 落到 toJS */ }
	if (doc !== null) {
		try { return node.toJS(doc); } catch { /* 不支持（如 !!js 自定义标签） */ }
	}
	return null;
}

/** YAML map 节点的纯 JS 字段（只保留标量，丢掉 undefined）——用于分类判断等只需要标量的场合。 */
function plainFields(node, doc = null) {
	if (!isMap(node)) return {};
	const js = nodeToJs(node, doc);
	if (js === null || Array.isArray(js)) return {};
	const out = {};
	for (const [key, value] of Object.entries(js)) {
		if (value === null || value === undefined) continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
	}
	return out;
}

/**
 * 恢复用的完整字段（**深**）：`config: {...}` 这类嵌套块必须原样带回来，否则"重建归属行"会丢配置。
 * 遇到不可序列化的自定义标签（`!!js` 等）回落到标量版本，绝不因一个怪标签把整行丢掉。
 */
function restorableFields(node, doc = null) {
	if (!isMap(node)) return {};
	const js = nodeToJs(node, doc);
	if (js !== null && !Array.isArray(js)) {
		const out = {};
		for (const [key, value] of Object.entries(js)) if (value !== undefined) out[key] = value;
		if (Object.keys(out).length > 0) return out;
	}
	return plainFields(node, doc);
}

function rowKey(row) {
	const id = typeof row?.id === "string" ? row.id : "";
	const name = typeof row?.name === "string" ? row.name : "";
	return `${id}\u0000${name}`;
}

/** 解析 patch 文本成行数组（每行记录 id / name / disabled / 是否有归属标记）。 */
export function parsePatchRows(text) {
	const doc = parseDocument(typeof text === "string" ? text : "");
	if (doc.errors.length > 0) {
		return { ok: false, errors: doc.errors.map((error) => error.message), doc: null, rows: [] };
	}
	if (!isSeq(doc.contents)) return { ok: false, errors: ["顶层不是 YAML 数组（引擎 boot 会失败）"], doc: null, rows: [] };
	const rows = [];
	doc.contents.items.forEach((item, index) => {
		if (!isMap(item)) {
			rows.push({ index, nonMap: true, id: null, name: null, disabled: null, owned: false, node: item });
			return;
		}
		const id = item.get("id");
		const name = item.get("name");
		rows.push({
			index,
			nonMap: false,
			id: typeof id === "string" ? id : null,
			name: typeof name === "string" ? name : null,
			disabled: item.get("disabled") === true,
			owned: ownedComment(item.commentBefore),
			node: item
		});
	});
	return { ok: true, errors: [], doc, rows };
}

/** 空 patch 判定：0 字节 / 只有注释 / 只有 `[]`。 */
export function isEmptyPatch(text) {
	if (typeof text !== "string") return true;
	const { text: stripped } = stripBom(text);
	if (stripped.trim() === "") return true;
	const meaningful = stripped
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("---"));
	if (meaningful.length === 0) return true;
	return meaningful.join("").replace(/\s+/g, "") === "[]";
}

/** 解析备份文件名里的时间戳（纯数字按 epoch ms / 秒，其它交给 Date.parse）。 */
export function parseBackupTimestamp(stamp) {
	const text = typeof stamp === "string" ? stamp.trim() : "";
	if (text === "") return { value: null, iso: null };
	if (/^\d{13}$/.test(text)) return { value: Number(text), iso: new Date(Number(text)).toISOString() };
	if (/^\d{10}$/.test(text)) return { value: Number(text) * 1000, iso: new Date(Number(text) * 1000).toISOString() };
	if (/^\d+$/.test(text)) return { value: Number(text), iso: null };
	const parsed = Date.parse(text);
	if (Number.isFinite(parsed)) return { value: parsed, iso: new Date(parsed).toISOString() };
	return { value: null, iso: null };
}

/** 列目录（不存在 → 空数组，不抛）。 */
function listDir(f, dir) {
	try { return f.readdirSync(dir); }
	catch { return []; }
}

/** 定位 DSH_HOME：参数 > 环境变量 > 由 profile 目录推导 > ~/.dsh（并报告全部候选）。 */
export function resolveDshHome({ dshHome = null, env = process.env, profileDir = null, homeDir = null } = {}) {
	const candidates = [];
	const push = (home, source) => {
		const absolute = resolve(home);
		if (candidates.some((item) => item.home.toLowerCase() === absolute.toLowerCase())) return;
		candidates.push({ home: absolute, source });
	};
	if (typeof dshHome === "string" && dshHome.trim() !== "") push(dshHome.trim(), "参数 dshHome");
	if (env !== null && typeof env === "object" && typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== "") {
		push(env.DSH_HOME.trim(), "环境变量 DSH_HOME");
	}
	if (typeof profileDir === "string" && profileDir.trim() !== "") {
		const dir = resolve(profileDir.trim());
		const parent = dirname(dir);
		if (basename(parent).toLowerCase() === "profiles") push(dirname(parent), `由 profile 目录推导（${dir}）`);
	}
	push(join(homeDir ?? homedir(), ".dsh"), "默认 ~/.dsh（homedir）");
	return { home: candidates[0].home, source: candidates[0].source, candidates };
}

/** 官方模板名（优先动态 import 官方包；不允许进 dependencies，失败即静态回落）。 */
export async function resolveKnownTemplates() {
	try {
		const mod = await import("@deepseek-ai/dsh-official-bundles");
		const templates = mod?.PROFILE_TEMPLATES;
		if (templates !== null && typeof templates === "object" && Object.keys(templates).length > 0) {
			return { templates: Object.keys(templates).sort(), source: "动态 import @deepseek-ai/dsh-official-bundles 的 PROFILE_TEMPLATES" };
		}
	} catch { /* 静态回落 */ }
	return { templates: [...STATIC_PROFILE_TEMPLATES], source: "静态回落副本（未 import 到官方包）" };
}

/** 命令行里需要引号的片段（含空格 / shell 元字符）。 */
function quoteArg(value) {
	const text = String(value);
	return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
//#endregion

//#region 1) 救援 profile（官方通道）
/**
 * 走官方通道建/重建救援 profile 并启动它：
 *   `<dshCmd> rescue --from-default-profile <sourceTemplate> [额外 app 参数]`
 * 与官方 help 的示例逐字一致（默认 `dsh rescue --from-default-profile web`）。
 *
 * `dryRun:true` 只返回**将要执行的命令与理由**，不执行（不 spawn、不写盘）。
 * `run` 可注入（测试用）：`run({command, argv, dshCmd, profileDir, dshHome, cwd})` → 退出码或 `{ok, code|exitCode}`。
 *
 * @param {object} [options]
 * @param {string|null} [options.dshHome] 权威 DSH_HOME（默认环境变量 → profile 推导 → ~/.dsh）
 * @param {string} [options.sourceTemplate] 官方模板名（默认 web）
 * @param {string} [options.profileName] 目标自定义 profile 名（默认 rescue）
 * @param {string} [options.dshCmd] dsh 命令（默认 dsh）
 * @param {Function|null} [options.run] 注入的执行器（默认 detached spawn）
 * @param {boolean} [options.dryRun] 只预览不执行（**本函数默认 false**：它是显式动作；--heal-recovery 才是默认 dry-run）
 * @param {string[]} [options.extraArgs] 追加给 profile 应用的参数（如 --port / --no-open）
 * @param {string|null} [options.logDir] detached 日志目录（默认 <DSH_HOME>/logs）
 * @param {string|null} [options.cwd] 子进程工作目录（默认用户主目录）
 * @param {object|null} [options.fsx] 注入 fs
 * @returns {Promise<object>} {ok, code, command, steps[], reason, ...}
 */
export async function buildRescueProfile({
	dshHome = null,
	sourceTemplate = DEFAULT_TEMPLATE,
	profileName = RESCUE_PROFILE_NAME,
	dshCmd = "dsh",
	run = null,
	dryRun = false,
	extraArgs = [],
	logDir = null,
	cwd = null,
	fsx = null
} = {}) {
	const f = fsAdapter(fsx);
	const steps = [];
	const warnings = [];
	const homeInfo = resolveDshHome({ dshHome });
	const home = homeInfo.home;
	const name = typeof profileName === "string" && profileName.trim() !== "" ? profileName.trim() : RESCUE_PROFILE_NAME;
	const template = typeof sourceTemplate === "string" && sourceTemplate.trim() !== "" ? sourceTemplate.trim() : DEFAULT_TEMPLATE;
	const profileDir = join(home, "profiles", name);

	// 红线：desktop 由 Electron 独占。本命令会**启动** Host，桌面场景一律拒绝（交给 bin 报 desktop-delegated）。
	if (name.toLowerCase() === "desktop") {
		return {
			ok: false,
			code: "desktop-delegated",
			command: null,
			argv: [],
			steps: [`拒绝：目标 profile 是官方独占的 desktop（F8）。桌面版引擎生命周期归 Electron，drydock 绝不 spawn 桌面 Host（红线 2）。`],
			reason: "desktop profile 由 Electron 独占：drydock 不建、不启、不写；请从系统托盘完全退出后重开，或改用 --heal-recovery。",
			profileName: name,
			profileDir,
			dshHome: home,
			sourceTemplate: template,
			dryRun: Boolean(dryRun),
			executed: false,
			warnings
		};
	}

	const known = await resolveKnownTemplates();
	steps.push(`① 解析 DSH_HOME：${home}（来源：${homeInfo.source}${homeInfo.candidates.length > 1 ? `；另有 ${homeInfo.candidates.length - 1} 个候选` : ""}）`);
	steps.push(`② 目标 profile：「${name}」（自定义名 → 目录 ${profileDir}）。官方保留名只有 ${known.templates.join(" / ")}，不在其中，因此可以作 --from-default-profile 的目标`);
	steps.push(`③ 模板：${template}（官方 PROFILE_TEMPLATES：${known.templates.join(" / ")}；来源：${known.source}）`);
	steps.push(`④ 完全不碰 desktop profile：本命令只作用于自定义 profile「${name}」；desktop 的 node_modules / state.json / lock / 插件激活一律不写（F8）`);

	if (!known.templates.includes(template)) {
		return {
			ok: false,
			code: "unknown-template",
			command: null,
			argv: [],
			steps: [...steps, `✗ 模板 ${JSON.stringify(template)} 不在官方 PROFILE_TEMPLATES 里（预期之一：${known.templates.join(" / ")}）`],
			reason: `模板名无效：${template}。官方只提供 ${known.templates.join(" / ")}，没有 rescue 模板——"救援 profile"是「自定义 profile 名 + 出厂模板」的组合。`,
			profileName: name,
			profileDir,
			dshHome: home,
			sourceTemplate: template,
			dryRun: Boolean(dryRun),
			executed: false,
			warnings
		};
	}

	const profileExists = f.existsSync(profileDir);
	if (profileExists) {
		const warning = `官方 --from-default-profile 是「重建」：目标目录 ${profileDir} 会在新目录就位后被删除（连同它自己的 cordis.patch.yml 与 .rescue-bak-* 备份）。需要保留就先自行复制。`;
		warnings.push(warning);
		steps.push(`⚠ ${warning}`);
	} else {
		steps.push(`· 目标目录当前不存在（首次创建）`);
	}

	const argv = [name, "--from-default-profile", template, ...(Array.isArray(extraArgs) ? extraArgs.map(String) : [])];
	const command = [dshCmd, ...argv].map(quoteArg).join(" ");
	const reason = `走官方通道重建救援 profile「${name}」← 出厂模板 ${template}，由官方 CLI 负责建目录 + 启动；不写 desktop profile，也不走 npm 的 dsh plugin --profile desktop（会被 rejectElectronProfile 拒绝）。`;
	steps.push(`${dryRun ? "将执行（dryRun，未执行）" : "执行"}：${command}`);

	const result = {
		ok: true,
		code: "dry-run",
		command,
		argv,
		steps,
		reason,
		profileName: name,
		profileDir,
		profileExists,
		dshHome: home,
		dshHomeSource: homeInfo.source,
		sourceTemplate: template,
		templates: known.templates,
		dryRun: Boolean(dryRun),
		executed: false,
		warnings
	};
	if (dryRun) return result;

	// 真正执行
	let raw;
	if (typeof run === "function") {
		try {
			raw = await run({ command, argv, dshCmd, profileDir, dshHome: home, sourceTemplate: template, cwd });
		} catch (error) {
			return {
				...result,
				ok: false,
				code: "spawn-failed",
				executed: false,
				reason: `执行失败：${error instanceof Error ? error.message : String(error)}`,
				steps: [...steps, `✗ 执行失败：${error instanceof Error ? error.message : String(error)}`]
			};
		}
	} else {
		try {
			raw = await spawnRescueDetached({ dshCmd, argv, cwd: cwd ?? homedir(), logDir: logDir ?? join(home, "logs"), fsx: f });
		} catch (error) {
			return {
				...result,
				ok: false,
				code: "spawn-failed",
				executed: false,
				reason: `无法启动 ${dshCmd}：${error instanceof Error ? error.message : String(error)}`,
				steps: [...steps, `✗ 无法启动 ${dshCmd}：${error instanceof Error ? error.message : String(error)}`]
			};
		}
	}

	const outcome = normalizeRunResult(raw);
	result.executed = true;
	result.exitCode = outcome.exitCode;
	result.pid = outcome.pid ?? null;
	result.logPath = outcome.logPath ?? null;
	result.stdout = outcome.stdout ?? "";
	result.stderr = outcome.stderr ?? "";
	result.dryRun = false;

	if (outcome.ok) {
		result.code = outcome.pending === true ? "booting" : "booted";
		steps.push(outcome.pending === true
			? `✓ 已启动（detached，pid ${result.pid ?? "未知"}；日志 ${result.logPath ?? "未落盘"}）——是否真的就绪由调用方做健康检查`
			: "✓ 命令执行完成（退出码 0）");
		return { ...result, steps };
	}

	result.ok = false;
	result.code = outcome.earlyExit === true ? "boot-exit" : "run-failed";
	steps.push(`✗ 命令失败（退出码 ${outcome.exitCode}${outcome.signal ? ` / ${outcome.signal}` : ""}）${result.logPath ? `；日志 ${result.logPath}` : ""}`);
	return {
		...result,
		steps,
		reason: `官方救援命令失败（退出码 ${outcome.exitCode}）。日志：${result.logPath ?? "（无）"}${outcome.stderr ? `；stderr：${String(outcome.stderr).slice(0, 400)}` : ""}`
	};
}

/** 归一化注入的 run() 返回值：数字 / {code|status|exitCode} / {ok} 全支持。 */
function normalizeRunResult(raw) {
	if (raw === null || raw === undefined) return { ok: true, exitCode: 0, pending: true };
	if (typeof raw === "number") return { ok: raw === 0, exitCode: raw, earlyExit: raw !== 0 };
	if (typeof raw === "boolean") return { ok: raw, exitCode: raw ? 0 : 1 };
	if (typeof raw !== "object") return { ok: true, exitCode: 0 };
	const exitCode = Number.isFinite(raw.exitCode) ? raw.exitCode : Number.isFinite(raw.code) ? raw.code : Number.isFinite(raw.status) ? raw.status : 0;
	const ok = raw.ok === undefined ? exitCode === 0 : raw.ok === true;
	return {
		ok,
		exitCode,
		earlyExit: raw.earlyExit === true || (raw.pending !== true && ok === false),
		pending: raw.pending === true,
		stdout: raw.stdout ?? "",
		stderr: raw.stderr ?? "",
		signal: raw.signal ?? null,
		pid: raw.pid ?? null,
		logPath: raw.logPath ?? null
	};
}

/**
 * 默认执行器：detached spawn（日志落盘而不是走管道——受限会话里默认管道 stdio 会 EPERM，仓库既有约定）。
 * 复用 lib/enginectl.mjs 的 `spawnEngineProcess`（.cmd/.bat 经 cmd.exe，含空格路径可用）；动态 import，
 * 这样注入了 `run` 的单测根本不加载 enginectl。
 */
async function spawnRescueDetached({ dshCmd, argv, cwd, logDir, fsx }) {
	const { spawnEngineProcess } = await import("./enginectl.mjs");
	try { fsx.mkdirSync(logDir, { recursive: true }); } catch { /* 目录可能已存在 */ }
	const logPath = join(logDir, `rescue-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
	let fd = null;
	try { fd = openSync(logPath, "a"); } catch { fd = null; }
	let child;
	try {
		child = spawnEngineProcess({ dshCmd, args: argv, cwd, logFd: fd });
	} finally {
		if (fd !== null) { try { closeSync(fd); } catch { /* 子进程已继承 fd */ } }
	}
	child.unref();

	// 抓"立刻失败"（命令不存在 / 秒退）：等 400ms 看有没有 error / exit
	const early = await new Promise((settle) => {
		let done = false;
		const finish = (value) => { if (!done) { done = true; settle(value); } };
		const timer = setTimeout(() => finish(null), 400);
		child.once("error", (error) => { clearTimeout(timer); finish({ error }); });
		child.once("exit", (code, signal) => { clearTimeout(timer); finish({ code, signal }); });
	});
	if (early && early.error) {
		const error = new Error(String(early.error.message ?? early.error));
		error.logPath = logPath;
		throw error;
	}
	if (early && early.code !== 0) {
		return { ok: false, exitCode: early.code ?? 1, signal: early.signal ?? null, pid: child.pid, logPath, earlyExit: true };
	}
	return { ok: true, pending: true, exitCode: 0, pid: child.pid, logPath };
}
//#endregion

//#region 2) 官方恢复痕迹检测（只读）
/**
 * 扫描官方恢复留下的痕迹：空 patch、`cordis.patch.yml.bak-<timestamp>`、
 * `package.json.bundles` 被摘（对比 drydock 自己的 `package.json.rescue-bak-*` 与侧车历史）。
 *
 * @param {object} [options]
 * @param {string} options.profileDir profile 绝对目录
 * @param {object|null} [options.fsx] 注入 fs
 * @returns {{detected: boolean, evidence: Array<object>, confidence: number, reason: string, details: object}}
 */
export function detectOfficialRecoveryTraces({ profileDir, fsx = null } = {}) {
	const f = fsAdapter(fsx);
	const dir = resolve(String(profileDir ?? ""));
	const profileName = basename(dir);
	const isDesktop = profileName.toLowerCase() === "desktop";
	const lockPath = join(dir, LOCK_FILENAME);
	const patchPath = join(dir, PATCH_FILENAME);
	const sidecarPath = join(dir, SIDECAR_FILENAME);
	const manifestPath = join(dir, MANIFEST_FILENAME);
	const evidence = [];

	// ---- profile 目录本身
	const profileExists = f.existsSync(dir);
	if (!profileExists) {
		evidence.push({ code: "profile-missing", file: profileName, path: dir, detail: "profile 目录不存在：没有任何可检测的痕迹（也没有可自愈的内容）" });
	}

	// ---- patch 本体
	const patchExists = f.existsSync(patchPath);
	const patchRead = patchExists ? readTextFile(f, patchPath) : null;
	const patchBytes = patchRead?.ok ? patchRead.bytes : 0;
	const patchEmpty = patchExists ? (patchRead?.ok ? isEmptyPatch(patchRead.text) : true) : true;
	if (!patchExists) {
		evidence.push({ code: "patch-missing", file: PATCH_FILENAME, path: patchPath, detail: "cordis.patch.yml 不存在（首次启动会建空 patch，本身不是恢复痕迹）" });
	} else if (patchEmpty) {
		evidence.push({ code: "patch-empty", file: PATCH_FILENAME, path: patchPath, detail: `cordis.patch.yml 是空 patch（${patchBytes} 字节，0 字节 / 只有 [] / 只有注释）` });
	} else {
		evidence.push({ code: "patch-present", file: PATCH_FILENAME, path: patchPath, detail: `cordis.patch.yml 非空（${patchBytes} 字节）` });
	}
	if (patchRead?.hadBom) {
		evidence.push({ code: "patch-bom", file: PATCH_FILENAME, path: patchPath, detail: "cordis.patch.yml 带 UTF-8 BOM（已剥离后再解析；写盘一律无 BOM）" });
	}

	// ---- 备份文件（官方 .bak-<ts> / drydock .rescue-bak-<ts>）
	const backups = [];
	for (const name of listDir(f, dir)) {
		const path = join(dir, name);
		let bytes = null;
		try { bytes = f.statSync(path).size; } catch { bytes = null; }
		const recovery = RECOVERY_BAK_RE.exec(name);
		const drydock = DRYDOCK_BAK_RE.exec(name);
		const manifestBak = MANIFEST_BAK_RE.exec(name);
		if (recovery) backups.push({ path, name, kind: "recovery-bak", stamp: recovery[1], bytes, ...parseBackupTimestamp(recovery[1]) });
		else if (drydock) backups.push({ path, name, kind: "drydock-bak", stamp: drydock[1], bytes, ...parseBackupTimestamp(drydock[1]) });
		else if (manifestBak) backups.push({ path, name, kind: "manifest-bak", stamp: manifestBak[1], bytes, ...parseBackupTimestamp(manifestBak[1]) });
	}
	backups.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.name.localeCompare(a.name));
	const recoveryBaks = backups.filter((item) => item.kind === "recovery-bak");
	const drydockBaks = backups.filter((item) => item.kind === "drydock-bak");
	const manifestBaks = backups.filter((item) => item.kind === "manifest-bak");
	for (const item of recoveryBaks) {
		evidence.push({
			code: "recovery-bak",
			file: item.name,
			path: item.path,
			stamp: item.stamp,
			iso: item.iso ?? null,
			detail: `官方恢复留下的 patch 备份${item.iso ? `（时间戳 → ${item.iso}）` : ""}，${item.bytes ?? "?"} 字节；它保存着恢复前**全部** patch 行（含 drydock 的归属行）`
		});
	}
	for (const item of drydockBaks) {
		evidence.push({ code: "drydock-bak", file: item.name, path: item.path, stamp: item.stamp, iso: item.iso ?? null, detail: `drydock 自己的写前备份，${item.bytes ?? "?"} 字节` });
	}
	for (const item of manifestBaks) {
		evidence.push({ code: "manifest-bak", file: item.name, path: item.path, stamp: item.stamp, iso: item.iso ?? null, detail: `drydock 改 package.json 前的备份，${item.bytes ?? "?"} 字节` });
	}

	// ---- package.json.bundles 是否被摘过
	let manifestBundles = null;
	let manifestRemoved = [];
	if (f.existsSync(manifestPath)) {
		const read = readTextFile(f, manifestPath);
		if (read.ok) {
			if (read.hadBom) evidence.push({ code: "manifest-bom", file: MANIFEST_FILENAME, path: manifestPath, detail: "package.json 带 UTF-8 BOM（已剥离）" });
			try {
				const parsed = JSON.parse(read.text);
				const bundles = parsed?.dsh?.profile?.bundles;
				if (Array.isArray(bundles)) manifestBundles = bundles.filter((item) => typeof item === "string");
			} catch (error) {
				evidence.push({ code: "manifest-unreadable", file: MANIFEST_FILENAME, path: manifestPath, detail: `package.json 无法解析：${error.message}` });
			}
		}
	}
	if (manifestBundles !== null && manifestBaks.length > 0) {
		const read = readTextFile(f, manifestBaks[0].path);
		if (read.ok) {
			try {
				const parsed = JSON.parse(read.text);
				const before = parsed?.dsh?.profile?.bundles;
				if (Array.isArray(before)) {
					const current = new Set(manifestBundles);
					manifestRemoved = before.filter((item) => typeof item === "string" && !current.has(item));
				}
			} catch { /* 备份不可解析 → 不据此下结论 */ }
		}
	}
	if (manifestRemoved.length > 0) {
		evidence.push({
			code: "bundles-shrank",
			file: MANIFEST_FILENAME,
			path: manifestPath,
			detail: `bundles 被摘过：${manifestRemoved.join(", ")}（对比 ${manifestBaks[0].name}；官方恢复会禁用第三方 bundle）`
		});
	}

	// ---- 侧车（plugin-manager.json）
	let sidecar = null;
	if (f.existsSync(sidecarPath)) {
		const read = readTextFile(f, sidecarPath);
		if (read.ok) {
			if (read.hadBom) evidence.push({ code: "sidecar-bom", file: SIDECAR_FILENAME, path: sidecarPath, detail: "侧车 JSON 带 UTF-8 BOM（已剥离后再解析）" });
			try {
				const parsed = JSON.parse(read.text);
				sidecar = {
					history: Array.isArray(parsed?.history) ? parsed.history : [],
					scenarios: Array.isArray(parsed?.scenarios) ? parsed.scenarios : [],
					overrides: parsed?.overrides?.source !== null && typeof parsed?.overrides?.source === "object" ? parsed.overrides.source : {},
					rescue: parsed?.rescue ?? {}
				};
				if (sidecar.history.length > 0 || sidecar.scenarios.length > 0) {
					evidence.push({
						code: "sidecar-intent",
						file: SIDECAR_FILENAME,
						path: sidecarPath,
						detail: `侧车记录了 drydock 的管理意图：操作历史 ${sidecar.history.length} 条 / 场景 ${sidecar.scenarios.length} 个（官方恢复不会动这个文件）`
					});
				}
			} catch (error) {
				evidence.push({ code: "sidecar-invalid", file: SIDECAR_FILENAME, path: sidecarPath, detail: `侧车 JSON 无法解析：${error.message}` });
			}
		}
	} else {
		evidence.push({ code: "sidecar-missing", file: SIDECAR_FILENAME, path: sidecarPath, detail: "没有侧车 plugin-manager.json：只能靠 .bak-* 备份恢复" });
	}

	// ---- 桌面持锁（只读事实，检测不做授权判断）
	const desktopLocked = isDesktop && f.existsSync(lockPath);
	if (desktopLocked) {
		evidence.push({ code: "desktop-lock", file: LOCK_FILENAME, path: lockPath, detail: "desktop profile 正被 Electron 持有单实例锁：此刻只读，不可写盘（F8）" });
	}

	// ---- 结论
	const hasRecoveryBak = recoveryBaks.length > 0;
	const sidecarIntent = sidecar !== null && (sidecar.history.length > 0 || sidecar.scenarios.length > 0);
	let confidence = 0;
	let reason;
	if (hasRecoveryBak && patchEmpty) {
		confidence = 0.9;
		reason = `检测到官方桌面版恢复痕迹：cordis.patch.yml 是空 patch，且存在 ${recoveryBaks.length} 个 .bak-<时间戳> 备份（${recoveryBaks[0].name}）——drydock 的归属行/开关行/隔离行已全部不在当前 patch 里。`;
	} else if (hasRecoveryBak) {
		confidence = 0.75;
		reason = `检测到官方恢复备份 ${recoveryBaks.map((item) => item.name).join(", ")}（当前 patch ${patchEmpty ? "为空" : "非空"}），可以据此重建归属行。`;
	} else if (manifestRemoved.length > 0) {
		confidence = 0.6;
		reason = `package.json 的 bundles 被摘过（${manifestRemoved.join(", ")}）：官方恢复会禁用第三方 bundle，需要按侧车/备份把归属行与开关状态补回来。`;
	} else if (patchEmpty && sidecarIntent) {
		confidence = 0.45;
		reason = "patch 是空的，但侧车里有 drydock 的管理意图（操作历史/场景）——很可能是恢复/重置把 patch 清掉了；没有 .bak-* 时只能按侧车意图重建能重建的那部分。";
	} else {
		confidence = 0;
		reason = "未检测到官方恢复痕迹（patch 正常、没有 .bak-<时间戳> 备份、bundles 未被摘）。";
	}

	return {
		detected: confidence > 0,
		evidence,
		confidence,
		reason,
		details: {
			profileDir: dir,
			profileName,
			isDesktop,
			desktopLocked,
			lockPath,
			patch: { path: patchPath, exists: patchExists, empty: patchEmpty, bytes: patchBytes, bom: patchRead?.hadBom === true },
			sidecar: { path: sidecarPath, exists: sidecar !== null, intent: sidecarIntent },
			manifest: { path: manifestPath, bundles: manifestBundles, removed: manifestRemoved },
			backups
		}
	};
}
//#endregion

//#region 3) 三分区判定 + 自愈计划（纯预览，绝不写盘）
/** 把一条 patch 行归入三分区：core（核心）/ builtin（内置）/ third-party（第三方）。 */
export function classifyRow(row) {
	const id = typeof row?.id === "string" ? row.id : "";
	const name = typeof row?.name === "string" ? row.name : "";
	if (id.startsWith("cordis:")) return "core";
	const bare = id.replace(/^cordis:/, "");
	if (bare !== "" && CORE_CONFIG_IDS.has(bare)) return "core";
	if (name !== "" && (STATIC_HIDDEN_BUNDLES.has(name) || STATIC_PROTECTED_PLUGINS.has(name))) return "builtin";
	return "third-party";
}

function readSidecarFile(f, path) {
	if (!f.existsSync(path)) return { found: false, bom: false, state: null };
	const read = readTextFile(f, path);
	if (!read.ok) return { found: false, bom: false, state: null, invalid: true, message: read.message };
	try {
		return { found: true, bom: read.hadBom, state: JSON.parse(read.text) };
	} catch (error) {
		return { found: false, bom: read.hadBom, state: null, invalid: true, message: error.message };
	}
}

/** 侧车意图：操作历史里的 patch-state 变更（configId + moduleName + enabled 都有）。 */
function sidecarIntentOf(sidecar) {
	const intent = [];
	if (sidecar === null || typeof sidecar !== "object") return intent;
	const history = Array.isArray(sidecar.history) ? sidecar.history : [];
	for (let i = history.length - 1; i >= 0; i -= 1) {
		const item = history[i];
		const changes = item?.undo?.changes;
		if (!Array.isArray(changes)) continue;
		for (const change of changes) {
			if (change === null || typeof change !== "object") continue;
			if (typeof change.configId !== "string" || typeof change.moduleName !== "string") continue;
			if (typeof change.enabled !== "boolean") continue;
			intent.push({
				id: change.configId,
				name: change.moduleName,
				disabled: change.enabled !== true,
				source: "sidecar:history",
				detail: `操作历史「${typeof item.label === "string" ? item.label : item.action ?? "未知"}」（${typeof item.at === "string" ? item.at : "时间未知"}）记录该开关${change.enabled === true ? "曾被启用" : "曾被停用"}`
			});
		}
	}
	return intent;
}

/**
 * 自愈计划（**纯预览**）：从最新 `.bak-*` / `.rescue-bak-*` 备份 + 侧车 `plugin-manager.json`
 * 算出要写回哪些归属行，并把核心/内置条目与用户自有行分开报告。**一行都不写**。
 *
 * @param {object} [options]
 * @param {string} options.profileDir 目标 profile 绝对目录
 * @param {string|null} [options.sidecarPath] 侧车路径（默认 <profile>/plugin-manager.json）
 * @param {object|null} [options.fsx] 注入 fs
 * @returns {object} {ok, willAdd[], willRestore[], preservedCore[], preservedBuiltin[], skipped[], ...}
 */
export function planSelfHeal({ profileDir, sidecarPath = null, fsx = null } = {}) {
	const f = fsAdapter(fsx);
	if (typeof profileDir !== "string" || profileDir.trim() === "") {
		return { ok: false, code: "missing-profile-dir", message: "缺少 profileDir（目标 profile 目录）", willAdd: [], willRestore: [], preservedCore: [], preservedBuiltin: [], skipped: [] };
	}
	const dir = resolve(profileDir.trim());
	const profileName = basename(dir);
	const isDesktop = profileName.toLowerCase() === "desktop";
	const lockPath = join(dir, LOCK_FILENAME);
	const desktopLocked = isDesktop && f.existsSync(lockPath);
	const patchPath = join(dir, PATCH_FILENAME);
	const sidePath = typeof sidecarPath === "string" && sidecarPath.trim() !== "" ? resolve(sidecarPath.trim()) : join(dir, SIDECAR_FILENAME);

	const bomStripped = [];
	const notes = [];
	const skipped = [];
	const willRestore = [];
	const willAdd = [];
	const preservedCore = [];
	const preservedBuiltin = [];
	const alreadyPresent = [];

	// ---- 当前 patch
	const patchExists = f.existsSync(patchPath);
	let patchRead = null;
	if (patchExists) {
		patchRead = readTextFile(f, patchPath);
		if (patchRead.ok && patchRead.hadBom) bomStripped.push({ file: patchPath, kind: "当前 patch" });
	}
	const patchText = patchRead?.ok ? patchRead.text : "";
	const patchEmpty = patchExists ? isEmptyPatch(patchText) : true;
	const patchParsed = patchRead?.ok ? parsePatchRows(patchText) : null;
	if (patchExists && patchParsed !== null && !patchParsed.ok) {
		notes.push(`当前 cordis.patch.yml 无法解析（${patchParsed.errors[0]}）——写盘时会先备份，再从空 patch 重建。`);
	}
	const currentRows = patchParsed?.ok ? patchParsed.rows.filter((row) => !row.nonMap) : [];
	const currentByKey = new Map(currentRows.map((row) => [rowKey(row), row]));
	if (patchEmpty && !patchExists) notes.push("当前没有 cordis.patch.yml（首次启动会是空 patch）。");
	if (patchEmpty && patchExists) notes.push("当前 cordis.patch.yml 是**空 patch**：drydock 的归属行已不在里面（这正是官方恢复后的形态）。");

	// ---- 备份来源（官方恢复备份优先，其次 drydock 自己的写前备份；新的在前）
	const backups = [];
	for (const name of listDir(f, dir)) {
		const path = join(dir, name);
		let bytes = null;
		try { bytes = f.statSync(path).size; } catch { bytes = null; }
		const recovery = RECOVERY_BAK_RE.exec(name);
		const drydock = DRYDOCK_BAK_RE.exec(name);
		if (recovery) backups.push({ path, name, kind: "recovery-bak", stamp: recovery[1], bytes, ...parseBackupTimestamp(recovery[1]) });
		else if (drydock) backups.push({ path, name, kind: "drydock-bak", stamp: drydock[1], bytes, ...parseBackupTimestamp(drydock[1]) });
	}
	const sources = [
		...backups.filter((item) => item.kind === "recovery-bak"),
		...backups.filter((item) => item.kind === "drydock-bak")
	].sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.name.localeCompare(a.name));

	// ---- package.json 的 bundles 被摘过？（官方恢复会禁用第三方 bundle；如实报告，但不擅自改 bundles）
	let bundlesRemoved = [];
	const manifestBaks = listDir(f, dir).filter((name) => MANIFEST_BAK_RE.test(name)).sort().reverse();
	if (manifestBaks.length > 0) {
		const current = readTextFile(f, join(dir, MANIFEST_FILENAME));
		const before = readTextFile(f, join(dir, manifestBaks[0]));
		if (current.ok && before.ok) {
			try {
				const currentBundles = JSON.parse(current.text)?.dsh?.profile?.bundles;
				const beforeBundles = JSON.parse(before.text)?.dsh?.profile?.bundles;
				if (Array.isArray(currentBundles) && Array.isArray(beforeBundles)) {
					const set = new Set(currentBundles.filter((item) => typeof item === "string"));
					bundlesRemoved = beforeBundles.filter((item) => typeof item === "string" && !set.has(item));
				}
			} catch { /* 备份不可解析 → 不下结论 */ }
		}
	}
	if (bundlesRemoved.length > 0) {
		notes.push(
			`⚠ package.json 的 dsh.profile.bundles 被摘过（${bundlesRemoved.join(", ")}，对比 ${manifestBaks[0]}）：`
			+ "自愈只重建 cordis.patch.yml 的归属行，**不会**把 bundle 加回 bundles，也不写 node_modules（红线）。"
			+ "这些插件要重新启用，得在插件管理器/官方 CLI 里加回（否则归属行写了也不会被加载）。"
		);
	}

	const seen = new Set();
	for (const source of sources) {
		const read = readTextFile(f, source.path);
		if (!read.ok) {
			skipped.push({ name: source.name, id: null, reason: `备份不可读（${read.code ?? "未知错误"}）`, path: source.path });
			continue;
		}
		if (read.hadBom) bomStripped.push({ file: source.path, kind: "备份 patch" });
		const parsed = parsePatchRows(read.text);
		if (!parsed.ok) {
			skipped.push({ name: source.name, id: null, reason: `备份不是合法 YAML 数组（${parsed.errors[0]}），跳过`, path: source.path });
			continue;
		}
		for (const row of parsed.rows) {
			if (row.nonMap) continue;
			const key = rowKey(row);
			if (seen.has(key)) continue;
			seen.add(key);
			const label = row.name ?? row.id ?? `第 ${row.index + 1} 行`;
			if (!row.owned) {
				skipped.push({ name: label, id: row.id, reason: "不是 drydock 归属行（没有归属标记）→ 不写回（用户/官方自持，红线：只动带归属标记的行）", path: source.path });
				continue;
			}
			const zone = classifyRow(row);
			if (zone === "core") {
				preservedCore.push({ id: row.id, name: row.name, why: "核心/架构保留条目：由引擎自身提供，drydock 只为它写过开关行、不由自愈重建（写了会和引擎层重复）", path: source.path });
				continue;
			}
			if (zone === "builtin") {
				preservedBuiltin.push({ id: row.id, name: row.name, why: "官方内置 bundle / 管理必需插件：由出厂模板提供且锁定，不写回", path: source.path });
				continue;
			}
			const existing = currentByKey.get(key);
			if (existing !== undefined) {
				if (!existing.owned) {
					skipped.push({ name: label, id: row.id, reason: "当前 patch 里已有同名行但不是 drydock 归属行 → 不覆盖（红线）", path: source.path });
					continue;
				}
				if (existing.disabled === (row.disabled === true)) {
					alreadyPresent.push({ id: row.id, name: row.name, disabled: existing.disabled, path: source.path });
					continue;
				}
			}
			willRestore.push({
				id: row.id,
				name: row.name,
				disabled: row.disabled === true,
				fields: restorableFields(row.node),
				action: existing === undefined ? "add" : "update",
				from: source.kind,
				path: source.path,
				reason: `从备份 ${source.name} 原样恢复归属行`
			});
		}
	}

	// ---- 侧车意图（备份缺失时唯一来源；只覆盖"能确定 id + 模块名"的部分）
	const sidecar = readSidecarFile(f, sidePath);
	if (sidecar.bom) bomStripped.push({ file: sidePath, kind: "侧车 JSON" });
	if (!sidecar.found) {
		if (sidecar.invalid) notes.push(`侧车 ${SIDECAR_FILENAME} 无法解析：${sidecar.message}`);
		else if (!f.existsSync(sidePath)) notes.push(`没有侧车 ${SIDECAR_FILENAME}：只能靠备份恢复。`);
	}
	const intent = sidecarIntentOf(sidecar.state);
	for (const item of intent) {
		const key = rowKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		const zone = classifyRow(item);
		if (zone === "core") {
			preservedCore.push({ id: item.id, name: item.name, why: `侧车的开关意图落在核心条目（${item.id}）上 → 不重建（核心行不由 drydock 写）`, path: sidePath });
			continue;
		}
		if (zone === "builtin") {
			preservedBuiltin.push({ id: item.id, name: item.name, why: `侧车的开关意图落在内置/锁定条目（${item.id}）上 → 不重建`, path: sidePath });
			continue;
		}
		const existing = currentByKey.get(key);
		if (existing !== undefined) {
			if (existing.owned && existing.disabled === (item.disabled === true)) {
				alreadyPresent.push({ id: item.id, name: item.name, disabled: existing.disabled, path: sidePath });
				continue;
			}
			if (!existing.owned) {
				skipped.push({ name: item.name, id: item.id, reason: "当前 patch 里已有同名行但不是 drydock 归属行 → 不覆盖（红线）", path: sidePath });
				continue;
			}
		}
		willAdd.push({
			id: item.id,
			name: item.name,
			disabled: item.disabled === true,
			fields: { id: item.id, name: item.name, disabled: item.disabled === true },
			action: "add",
			from: item.source,
			path: sidePath,
			reason: item.detail
		});
	}

	// ---- 场景方案：只记录了 configId，没有模块名 → 无法单独重建（如实报告，不假装能恢复）
	if (sidecar.found && Array.isArray(sidecar.state?.scenarios)) {
		for (const scenario of sidecar.state.scenarios) {
			const states = scenario?.states;
			if (states === null || typeof states !== "object") continue;
			for (const configId of Object.keys(states)) {
				if (typeof configId !== "string" || configId === "") continue;
				const key = `${configId}\u0000`;
				const matched = [...seen].some((seenKey) => seenKey === key || seenKey.startsWith(`${configId}\u0000`));
				if (matched) continue;
				skipped.push({
					name: null,
					id: configId,
					reason: `场景方案「${scenario.name ?? "未命名"}」只记了 configId（没有模块名）→ 无法单靠它重建 patch 行；需要 .bak-* 备份`,
					path: sidePath
				});
			}
		}
	}

	const rows = [...willRestore, ...willAdd];
	const ok = true;
	const summary = {
		profileDir: dir,
		profileName,
		isDesktop,
		desktopLocked,
		lockPath,
		patchPath,
		patchExists,
		patchEmpty,
		sidecarPath: sidePath,
		sidecarFound: sidecar.found,
		bundlesRemoved,
		backups,
		sourcesUsed: sources.map((item) => ({ path: item.path, kind: item.kind, iso: item.iso ?? null }))
	};
	return {
		ok,
		...summary,
		willAdd,
		willRestore,
		preservedCore,
		preservedBuiltin,
		skipped,
		alreadyPresent,
		rows,
		bomStripped,
		notes,
		message: planMessage({ profileName, isDesktop, desktopLocked, willAdd, willRestore, preservedCore, preservedBuiltin, skipped, bomStripped, bundlesRemoved, notes })
	};
}

function planMessage({ profileName, isDesktop, desktopLocked, willAdd, willRestore, preservedCore, preservedBuiltin, skipped, bomStripped, bundlesRemoved = [], notes = [] }) {
	const lines = [];
	lines.push(`目标 profile：${profileName}${isDesktop ? "（desktop：Electron 独占）" : ""}`);
	if (desktopLocked) lines.push("⚠ desktop profile 正被 Electron 持有单实例锁：现在只能看，不能写。");
	lines.push(`将恢复归属行 ${willRestore.length} 条（从备份原样写回）+ 按侧车重建 ${willAdd.length} 条`);
	for (const row of willRestore) lines.push(`  · [恢复] ${row.name ?? row.id}（disabled: ${row.disabled}，来源 ${basename(row.path)}）`);
	for (const row of willAdd) lines.push(`  · [重建] ${row.name ?? row.id}（disabled: ${row.disabled}，来源 ${row.from}）`);
	lines.push(`保留核心条目 ${preservedCore.length} 条、内置锁定条目 ${preservedBuiltin.length} 条（不写回）`);
	for (const item of preservedCore) lines.push(`  · [核心保留] ${item.name ?? item.id}`);
	for (const item of preservedBuiltin) lines.push(`  · [内置保留] ${item.name ?? item.id}`);
	if (skipped.length > 0) lines.push(`跳过 ${skipped.length} 条（含用户自有行）：`);
	for (const item of skipped) lines.push(`  · [跳过] ${item.name ?? item.id ?? "?"}：${item.reason}`);
	if (bundlesRemoved.length > 0) lines.push(`⚠ bundles 被摘过：${bundlesRemoved.join(", ")}（自愈不写 package.json，需要在插件管理器里重新启用）`);
	for (const note of notes) lines.push(`ℹ ${note}`);
	if (bomStripped.length > 0) lines.push(`BOM 已识别并剥离 ${bomStripped.length} 处（${bomStripped.map((item) => basename(item.file)).join("、")}）；写盘一律无 BOM`);
	return lines.join("\n");
}
//#endregion

//#region 4) 恢复后自愈（分级授权 + 可逆写）
/**
 * 官方恢复之后的自愈：从侧车 `plugin-manager.json` + `.rescue-bak-*` / `.bak-<ts>` 备份重建归属行。
 *
 * 分级授权（契约红线）：
 *  1. `profiles/desktop/lock` 存在 → **拒绝写盘**，`code: "desktop-locked"`，附只读预览（解锁后会自动做什么）；
 *  2. desktop 但未持锁 → 只做 `cordis.patch.yml` 级**可逆**写（写前备份 + 只动带归属标记的行），
 *     且必须 `confirm === <profileName>`；未确认 → `code: "confirm-required"`；
 *     `allowDesktop !== true` → `code: "desktop-not-allowed"`；
 *  3. web profile → 行为与现状一致（不受影响，无需 confirm / allowDesktop）；
 *  4. `dryRun` **默认 true**；必须显式 `dryRun:false` 才写。
 *
 * @param {object} [options]
 * @param {string} options.profileDir 目标 profile 绝对目录
 * @param {string|null} [options.sidecarPath] 侧车路径（默认 <profile>/plugin-manager.json）
 * @param {object|null} [options.fsx] 注入 fs
 * @param {boolean} [options.dryRun] 默认 true
 * @param {string|null} [options.confirm] 显式确认（desktop 下必须等于 profile 名）
 * @param {boolean} [options.allowDesktop] 是否显式允许对 desktop profile 写
 * @returns {object}
 */
export function selfHealAfterRecovery({ profileDir, sidecarPath = null, fsx = null, dryRun = true, confirm = null, allowDesktop = false } = {}) {
	const f = fsAdapter(fsx);
	const plan = planSelfHeal({ profileDir, sidecarPath, fsx: f });
	if (!plan.ok) return { ok: false, code: plan.code ?? "plan-failed", message: plan.message ?? "无法生成自愈计划", plan };
	const { profileName, isDesktop, desktopLocked, lockPath, patchPath } = plan;
	const rows = plan.rows ?? [];
	const target = { profileName, profileDir: plan.profileDir, patchPath, isDesktop, desktopLocked, lockPath };
	const confirmed = typeof confirm === "string" && confirm.trim() !== "" ? confirm.trim() : null;

	// ---- 1) 安全默认：dry-run
	if (dryRun !== false) {
		const head = rows.length === 0
			? `dry-run（默认）：没有需要恢复的归属行——${plan.patchEmpty ? "当前已是空 patch 且没有可用备份" : "当前 patch 已包含侧车/备份里的归属行"}。`
			: `dry-run（默认）：计划写 ${rows.length} 条归属行（${rows.map((row) => row.name ?? row.id).join("、")}），实际未写盘。`;
		return {
			ok: true,
			code: "dry-run",
			dryRun: true,
			target,
			plan,
			rows,
			message: [head, desktopLocked ? `⚠ 该 profile 现在被 Electron 持锁（${lockPath}）：真正执行会被拒绝（code: desktop-locked）。` : null, plan.message].filter(Boolean).join("\n")
		};
	}

	// ---- 2) 持锁：一律拒绝（不论 confirm / allowDesktop）
	if (desktopLocked) {
		return {
			ok: false,
			code: "desktop-locked",
			dryRun: false,
			target,
			plan,
			preview: {
				wouldRestore: plan.willRestore.map((row) => ({ id: row.id, name: row.name, disabled: row.disabled })),
				wouldAdd: plan.willAdd.map((row) => ({ id: row.id, name: row.name, disabled: row.disabled })),
				preservedCore: plan.preservedCore.length,
				preservedBuiltin: plan.preservedBuiltin.length,
				skipped: plan.skipped.length
			},
			message: desktopLockedMessage({ profileDir: plan.profileDir, lockPath, plan })
		};
	}

	// ---- 3) desktop 未持锁：要求显式 confirm（等于 profile 名）
	if (isDesktop && confirmed !== profileName) {
		return {
			ok: false,
			code: "confirm-required",
			dryRun: false,
			target,
			plan,
			message: [
				`拒绝写盘：desktop profile 需要二次确认（可逆写也要先确认目标）。`,
				`目标 profile：${profileName}（${plan.profileDir}）`,
				`请显式加上 --confirm ${profileName} 重跑（本次未改动任何文件）。`,
				`将改动的行（${rows.length} 条）：${rows.map((row) => `${row.name ?? row.id}(disabled:${row.disabled})`).join("、") || "（无）"}`
			].join("\n")
		};
	}

	// ---- 4) desktop 需要显式允许（bin 的 --allow-desktop）
	if (isDesktop && allowDesktop !== true) {
		return {
			ok: false,
			code: "desktop-not-allowed",
			dryRun: false,
			target,
			plan,
			message: [
				"拒绝写盘：没有显式允许对 desktop profile 执行（需要 --allow-desktop）。",
				`原因：desktop profile 由 Electron 独占（F8）；drydock 只做 cordis.patch.yml 级可逆写，但必须先由人明确允许。`,
				`本次未改动任何文件；确认后可重跑：--heal-recovery --apply --confirm ${profileName} --allow-desktop`
			].join("\n")
		};
	}

	// ---- 5) 无可写
	if (rows.length === 0) {
		return {
			ok: true,
			code: "nothing-to-do",
			dryRun: false,
			target,
			plan,
			applied: [],
			message: `无需改动：侧车与备份里的归属行都已在 patch 中（或不适用）。${plan.patchEmpty ? "当前 patch 是空 patch。" : ""}`
		};
	}

	// ---- 6) 写：备份 → 合并 → 原子写 → 复检（失败回滚）
	const backupPath = `${patchPath}.rescue-bak-${Date.now()}`;
	try {
		if (plan.patchExists) {
			const before = readTextFile(f, patchPath);
			if (!before.ok) return { ok: false, code: "read-failed", dryRun: false, target, plan, message: `读取 ${patchPath} 失败（${before.code ?? "未知"}），已中止，未改动任何文件。` };
			// 备份用**原始字节**（含 BOM 时保留原样）
			f.writeFileSync(backupPath, before.raw, "utf8");
		}
	} catch (error) {
		return { ok: false, code: "backup-failed", dryRun: false, target, plan, message: `写前备份失败，已中止（未改动任何文件）：${error instanceof Error ? error.message : String(error)}` };
	}

	let document;
	if (plan.patchExists) {
		const read = readTextFile(f, patchPath);
		document = read.ok ? parseDocument(read.text) : parseDocument("[]\n");
		if (document.errors.length > 0 || !isSeq(document.contents)) {
			plan.notes.push("原 cordis.patch.yml 无法解析：已备份，并从空 patch 重建。");
			document = parseDocument("[]\n");
		}
	} else {
		document = parseDocument("[]\n");
	}
	const sequence = document.contents;
	// 官方恢复后 patch 是 `[]`（flow 序列）：直接 add 会写成 `[ #注释 {…} ]`，可读性差。
	// 这里强制改回 block 风格 —— 与 profile 里既有 patch（`- id: …` 一行一条）保持一致。
	if (sequence.flow === true) sequence.flow = false;

	const applied = [];
	const skippedNow = [];
	try {
		for (const row of rows) {
			const desired = row.disabled === true;
			const fields = { ...(row.fields ?? {}), id: row.id ?? row.fields?.id, name: row.name ?? row.fields?.name, disabled: desired };
			for (const key of Object.keys(fields)) if (fields[key] === null || fields[key] === undefined) delete fields[key];
			let existing = null;
			for (const item of sequence.items) {
				if (!isMap(item)) continue;
				if ((item.get("id") ?? null) === (fields.id ?? null) && (item.get("name") ?? null) === (fields.name ?? null)) { existing = item; break; }
			}
			if (existing !== null) {
				// 红线：只动带归属标记的行
				if (!ownedComment(existing.commentBefore)) {
					skippedNow.push({ name: fields.name ?? fields.id, reason: "当前 patch 里的同名行不是 drydock 归属行 → 不覆盖" });
					continue;
				}
				for (const [key, value] of Object.entries(fields)) existing.set(key, value);
				applied.push({ id: fields.id ?? null, name: fields.name ?? null, disabled: desired, action: "update" });
				continue;
			}
			const node = document.createNode(fields);
			sequence.add(node);
			const added = sequence.items.at(-1);
			if (!isMap(added)) throw new Error("创建的 patch 行不是 YAML map");
			added.commentBefore = OWNER_MARKER;
			applied.push({ id: fields.id ?? null, name: fields.name ?? null, disabled: desired, action: "add" });
		}
	} catch (error) {
		rollbackPatch(f, { patchPath, backupPath, hadPatch: plan.patchExists });
		return { ok: false, code: "merge-failed", dryRun: false, target, plan, message: `合并 patch 行失败，已回滚到备份：${error instanceof Error ? error.message : String(error)}` };
	}

	// 原子写（utf8，**无 BOM**）
	try {
		const serialized = String(document);
		const text = serialized.endsWith("\n") ? serialized : `${serialized}\n`;
		const temporary = `${patchPath}.${process.pid}.${Date.now()}.tmp`;
		f.writeFileSync(temporary, text, "utf8");
		f.renameSync(temporary, patchPath);
	} catch (error) {
		rollbackPatch(f, { patchPath, backupPath, hadPatch: plan.patchExists });
		return { ok: false, code: "write-failed", dryRun: false, target, plan, message: `写盘失败，已回滚：${error instanceof Error ? error.message : String(error)}` };
	}

	// 复检：重新读盘逐条核对（"第三方逐个加回并复检"）
	const verify = verifyHealedPatch(f, patchPath, applied);
	if (!verify.ok) {
		rollbackPatch(f, { patchPath, backupPath, hadPatch: plan.patchExists });
		return {
			ok: false,
			code: "verify-failed",
			dryRun: false,
			target,
			plan,
			applied,
			backupPath: plan.patchExists ? backupPath : null,
			verify,
			message: `复检未通过，已回滚到写前状态：${verify.problems.join("；")}`
		};
	}

	return {
		ok: true,
		code: "healed",
		dryRun: false,
		target,
		plan,
		applied,
		skippedNow,
		backupPath: plan.patchExists ? backupPath : null,
		verify,
		message: [
			`已恢复 ${applied.length} 条归属行（${applied.map((row) => row.name ?? row.id).join("、")}）→ ${patchPath}`,
			plan.patchExists ? `写前备份：${backupPath}` : "（原文件不存在，未产生备份）",
			`复检：通过（重新读盘核对 ${applied.length}/${applied.length} 条、YAML 可解析、写盘无 BOM）`,
			plan.preservedCore.length + plan.preservedBuiltin.length > 0
				? `保留未写回：核心 ${plan.preservedCore.length} 条 / 内置锁定 ${plan.preservedBuiltin.length} 条`
				: null,
			skippedNow.length > 0 ? `跳过：${skippedNow.map((item) => item.reason).join("；")}` : null,
			isDesktop ? "说明：只做了 cordis.patch.yml 级可逆写（未碰 node_modules / state.json / lock）。" : null
		].filter(Boolean).join("\n")
	};
}

/** 写盘——复检：重新读盘，逐条核对 id/name/disabled 与"无 BOM / 可解析"。 */
function verifyHealedPatch(f, patchPath, applied) {
	const problems = [];
	const read = readTextFile(f, patchPath);
	if (!read.ok) return { ok: false, problems: [`复检读取失败（${read.code ?? "未知"}）`] };
	if (read.hadBom) problems.push("写出的文件带 BOM（应为无 BOM）");
	const parsed = parsePatchRows(read.text);
	if (!parsed.ok) return { ok: false, problems: [`写出的 YAML 无法解析：${parsed.errors[0]}`] };
	const byKey = new Map(parsed.rows.filter((row) => !row.nonMap).map((row) => [rowKey(row), row]));
	for (const row of applied) {
		const found = byKey.get(`${row.id ?? ""}\u0000${row.name ?? ""}`);
		if (found === undefined) { problems.push(`复检找不到行 ${row.name ?? row.id}`); continue; }
		if (found.disabled !== (row.disabled === true)) problems.push(`行 ${row.name ?? row.id} 的 disabled 不是 ${row.disabled}`);
	}
	return { ok: problems.length === 0, problems, rows: parsed.rows.filter((row) => !row.nonMap).length };
}

/** 回滚：有备份就原样写回；原本没有 patch 就写回空数组。 */
function rollbackPatch(f, { patchPath, backupPath, hadPatch }) {
	try {
		if (hadPatch) {
			const backup = readTextFile(f, backupPath);
			if (backup.ok) f.writeFileSync(patchPath, backup.raw, "utf8");
		} else {
			f.writeFileSync(patchPath, "[]\n", "utf8");
		}
	} catch { /* 回滚失败不掩盖原始错误 */ }
}

/** desktop 持锁时的完整拒绝文案（用户实际看到的东西）。 */
function desktopLockedMessage({ profileDir, lockPath, plan }) {
	const would = plan.willRestore.length + plan.willAdd.length;
	const lines = [
		"❌ 拒绝写盘：desktop profile 正被桌面版（Electron）持有单实例锁。",
		`   profile：${profileDir}`,
		`   锁文件：${lockPath}`,
		"   原因：桌面版独占 profiles/desktop + 包管理器状态 + 进程级单实例锁（F8）；持锁时任何写盘都可能与正在运行的 Host 冲突。",
		"   drydock 在桌面场景不写 node_modules、不写 state.json、不写 lock，只做 cordis.patch.yml 级可逆写——但现在连这个也不做。",
		"   请先：从系统托盘完全退出 DeepSeek Harness（不是关窗口，是「退出」），然后重开此操作。",
		`   解锁后会自动执行（本次未做任何改动）：恢复 ${would} 条归属行（从备份原样写回 ${plan.willRestore.length} 条 / 按侧车重建 ${plan.willAdd.length} 条）`
	];
	if (plan.preservedCore.length > 0 || plan.preservedBuiltin.length > 0) {
		lines.push(`   保留不写回：核心 ${plan.preservedCore.length} 条 / 内置锁定 ${plan.preservedBuiltin.length} 条`);
	}
	if (plan.skipped.length > 0) lines.push(`   跳过：${plan.skipped.length} 条（含用户自有行，不覆盖）`);
	if (would > 0) {
		lines.push("   条目清单：");
		for (const row of [...plan.willRestore, ...plan.willAdd]) lines.push(`     · ${row.name ?? row.id}（disabled: ${row.disabled === true}）`);
	}
	return lines.join("\n");
}
//#endregion

// 供测试直接注入/断言的内部件
export const __internals = { fsAdapter, readTextFile, spawnRescueDetached, verifyHealedPatch, planMessage, desktopLockedMessage };
