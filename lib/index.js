import { findPackageJSON } from "node:module";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isSeq, parseDocument } from "yaml";

/**
 * 本地插件管理器 —— 宿主端。
 *
 * 列表投影：名称 / 功能简介 / 必要程度 / 启用状态（含运行期错误与版本更新检测）。
 * 开关：把目标状态持久化到 profile 的 cordis.patch.yml（带归属标记的行），
 * Loader 热重载生效；无法在运行期收敛时回报 restart-required。
 *
 * 补丁持久化机制借鉴 MIT 项目 hrhgit/deepseek-harness-plugin-manager 的实现思路。
 */

//#region 元数据目录：功能简介 + 必要程度（core=必须红 / recommended=推荐黄 / optional=可选绿）
const DESCRIPTIONS = {
	// —— 基础层 dsh-base ——
	"timer": "定时器基础设施，任务调度/超时依赖",
	"hmr": "开发期热重载（生产关闭）",
	"llm": "模型接入与请求编排（对话/标题/子代理共用）",
	"session": "会话核心：历史、事件日志、回放",
	"typert": "Typert 协议注册表（远程调用元数据）",
	"typert-loader": "Typert 协议加载器",
	"typert-gateway": "Typert API 网关（可信宿主调用面）",
	"session-title": "会话标题生成",
	"session-title-llm": "基于 LLM 的会话标题",
	"user-questions": "向用户提问的能力",
	"agent": "Agent 核心：工具调用与回合",
	"agent-default-model": "默认模型选择（deepseek-v4-flash）",
	"jobs": "后台任务（本地）",
	"llm-retry": "LLM 调用自动重试",
	"settings": "设置读写（settings.yaml）",
	"credentials": "凭据存储（API Key 等）",
	"llm-pi-ai": "Pi AI 模型通道",
	"session-persistence-jsonl": "会话 JSONL 持久化",
	"attachment-local": "附件（本地文件）",
	"session-query-sqlite": "会话 SQLite 查询",
	"session-projection": "会话投影（供 UI 增量渲染）",
	"session-telemetry-otel": "遥测（默认关闭）",
	"subprocess": "子进程执行基础设施",
	"sandbox": "沙箱后端（本地）",
	"sandbox-policy": "沙箱策略：read-only / workspace-write / danger-full-access",
	"bash-sandbox": "Bash 沙箱（Windows 关闭）",
	"pwsh-sandbox": "PowerShell 沙箱（Windows 启用）",
	"approval": "审批策略（danger-full-access 下为 never）",
	"permission": "权限预设（read-only / workspace-write / danger-full-access）",
	"shell-env": "Shell 环境变量投影",
	"tool-bash": "Bash 工具（服务端行；浏览器端提供）",
	"tool-pwsh": "PowerShell 工具（服务端行；浏览器端提供）",
	"tool-jobs": "后台任务工具（浏览器端提供）",
	"fs-observation-policy": "文件观察策略（读前必读等）",
	"tool-fs": "文件读写工具（浏览器端提供）",
	"tool-fs-search": "文件检索工具（grep/glob，浏览器端提供）",
	"agent-instructions": "Agent 指令注入",
	"skill": "技能（Skill）系统核心",
	"skill-filesystem": "技能文件系统（按技能加载）",
	"skill-badge": "技能徽标（当前技能标记）",
	"tool-skill": "技能工具",
	"commands": "命令系统（/命令）",
	"command-feedback": "反馈命令",
	"goal": "目标系统核心（长任务目标）",
	"goal-round-driver": "目标回合驱动",
	"command-goal": "目标命令",
	"plan-mode": "计划模式（exit_plan_mode 审批）",
	"token-meter": "Token 计量",
	"compaction-basic": "上下文压缩（基础）",
	"command-compact": "压缩命令",
	"subagent": "子代理系统核心",
	"subagent-spawn-in-process": "子代理（进程内 spawn）",
	"subagent-fork-in-process": "子代理（fork 继承上下文）",
	"tool-subagent-control": "子代理控制工具（list/interrupt）",
	"tool-subagent-list-agents": "子代理清单工具",
	"tool-subagent": "子代理工具（spawn）",
	"tool-subagent-fork": "子代理工具（fork）",
	"tool-subagent-report": "子代理结果上报",
	"workflow-worker-thread": "工作流工作线程",
	"tool-workflow": "工作流工具（多代理编排）",
	"timeout-policy": "工具调用超时策略",
	"spill-local": "大输出转储（本地临时文件）",
	"spill-policy": "转储策略（>50KB 转文件）",
	"session-checkpoint-policy": "会话检查点策略",
	"tool-result-pruner": "工具结果裁剪",
	"tool-todo": "任务清单工具（todo_write）",
	"tool-goal": "目标工具（create_goal 等）",
	"tool-ralph": "Ralph 循环工具",
	"tool-str-replace-editor": "字符串替换编辑器工具",
	"repeat-tool-reminder": "工具重试提醒",
	"web": "Web 表面：网页搜索提供方",
	"web-search-deepseek": "DeepSeek 网页搜索",
	"tool-web": "网页搜索工具（浏览器端提供）",
	"tools": "工具注册总装（按工具模式）",
	"system-prompt": "系统提示词",
	"agent-loop": "Agent 循环（工具派发）",
	"fs-sandbox": "文件沙箱（危险模式全放开）",
	"llm-deepseek": "DeepSeek 官方模型通道",
	// —— Web 应用层 dsh-web-app ——
	"code-runtime": "代码运行环境（worker 线程）",
	"storage": "存储核心",
	"storage-json": "JSON 存储后端",
	"storage-domain": "存储域（按域命名空间）",
	"message-feedback": "消息反馈（点赞/踩）",
	"session-log-download": "会话日志导出下载",
	"workspace": "工作区管理",
	"session-projection-cache": "会话投影缓存（增量持久化）",
	"session-stats": "会话统计",
	"directory-picker": "目录选择器（自动）",
	"plugin-inventory": "插件清单投影（只读，供设置页）",
	"api-gateway": "API 网关（宿主）",
	"cordis-host-runner": "宿主侧 Cordis 运行器",
	"web-startup": "Web 启动参数解析（端口等）",
	"webserver": "Web 服务器（127.0.0.1:3080）",
	"web-runtime": "Web 运行时粘合（前端分发、URL）",
	"client-hmr": "客户端热重载（开发）",
	"modules": "客户端模块系统（插件 bundle 路由）",
	"connection": "浏览器连接（可信宿主）",
	"api-remotes": "远程 API 面（客户端插件调用）",
	"client-runtime": "客户端运行时（浏览器插件宿主）",
	"cordis-client-runner": "浏览器端 Cordis 运行器",
	"ui-theme": "主题",
	"locale": "本地化（中/英）",
	"ui-layout": "界面布局",
	"ui-sidebar": "侧边栏",
	"ui-settings": "设置界面",
	"ui-settings-general": "通用设置页",
	"ui-settings-models": "模型设置页",
	"ui-settings-plugin-inventory": "只读插件清单页（已被本管理器替换）",
	"ui-conversation": "对话界面",
	"ui-tool": "工具调用卡片",
	"ui-cordis": "Cordis 状态界面",
	"ui-workflow-run": "工作流运行界面",
	"ui-deliverables": "交付物界面",
	"ui-workspace": "工作区界面",
	"ui-input-trigger": "输入触发（斜杠命令等）",
	"ui-commands": "命令面板",
	"ui-skill": "技能界面",
	"ui-subagent": "子代理界面",
	"ui-jobs": "后台任务界面",
	"ui-goal": "目标界面",
	"ui-message-feedback": "消息反馈界面",
	"ui-model-selection": "模型选择器",
	"ui-permission": "权限预设界面（ask/never 切换）",
	"ui-agent-preset": "Agent 预设界面",
	"ui-settings-plugins": "插件设置区（承载本管理器的 tab）",
	"ui-plan": "计划模式界面",
	"ui-user-questions": "用户提问界面",
	"ui-trajectory": "轨迹（运行历史）界面",
	"agent-presets": "Agent 预设（standard 等）",
	// —— 本插件 ——
	"plugin-manager-pro": "插件管理器：列表/简介/必要程度/状态/开关"
};

const NECESSITY = {
	// core=必须（红）：关掉就没法用的基础设施
	"timer": "core",
	"llm": "core",
	"session": "core",
	"typert": "core",
	"typert-loader": "core",
	"typert-gateway": "core",
	"agent": "core",
	"agent-default-model": "core",
	"settings": "core",
	"credentials": "core",
	"session-persistence-jsonl": "core",
	"subprocess": "core",
	"sandbox": "core",
	"sandbox-policy": "core",
	"approval": "core",
	"permission": "core",
	"shell-env": "core",
	"fs-observation-policy": "core",
	"tools": "core",
	"system-prompt": "core",
	"agent-loop": "core",
	"fs-sandbox": "core",
	"llm-deepseek": "core",
	"web": "core",
	"web-search-deepseek": "core",
	"code-runtime": "core",
	"storage": "core",
	"storage-json": "core",
	"storage-domain": "core",
	"api-gateway": "core",
	"cordis-host-runner": "core",
	"web-startup": "core",
	"webserver": "core",
	"web-runtime": "core",
	"modules": "core",
	"connection": "core",
	"api-remotes": "core",
	"client-runtime": "core",
	"cordis-client-runner": "core",
	"locale": "core",
	"ui-layout": "core",
	"ui-settings": "core",
	"ui-settings-general": "core",
	"ui-settings-plugins": "core",
	"ui-conversation": "core",
	"skill": "core",
	"commands": "core",
	"session-projection": "core",
	"jobs": "core",
	"plugin-manager-pro": "core",
	// optional=可选（绿）：锦上添花
	"hmr": "optional",
	"session-telemetry-otel": "optional",
	"bash-sandbox": "optional",
	"skill-badge": "optional",
	"command-feedback": "optional",
	"ui-workflow-run": "optional",
	"ui-deliverables": "optional",
	"ui-trajectory": "optional",
	"ui-message-feedback": "optional",
	"ui-model-selection": "optional",
	"client-hmr": "optional",
	"ui-agent-preset": "optional",
	"session-stats": "optional",
	"message-feedback": "optional",
	"session-log-download": "optional"
	// 其余默认 recommended=推荐（黄）
};
//#endregion

//#region profile 补丁持久化（借鉴 MIT 项目 dsh-plugin-manager 的实现）
const PATCH_FILENAME = "cordis.patch.yml";
const OWNER_MARKER = "Managed by @dsh-local/plugin-manager. Remove this row to return control to higher-level configuration.";

function profileLocation(baseUrl) {
	if (!baseUrl.startsWith("file:")) throw new Error("@dsh-local/plugin-manager requires a file-backed profile config");
	const root = fileURLToPath(baseUrl);
	const directory = baseUrl.endsWith("/") ? root : dirname(root);
	return {
		directory,
		filename: join(directory, PATCH_FILENAME),
		profileName: basename(directory)
	};
}

function emptyDocument() {
	return parseDocument("[]\n");
}

async function readDocument(filename) {
	let source;
	try {
		source = await readFile(filename, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return emptyDocument();
		throw error;
	}
	const document = parseDocument(source);
	if (document.errors.length > 0) throw new Error(`cannot parse ${filename}: ${document.errors[0]?.message}`);
	if (!isSeq(document.contents)) throw new Error(`${filename} must contain a YAML sequence of patches`);
	return document;
}

function scalarString(map, key) {
	const value = map.get(key);
	return typeof value === "string" ? value : void 0;
}

function ownedPatch(sequence, configId, moduleName) {
	return sequence.items.find((item) => {
		if (!isMap(item) || scalarString(item, "id") !== configId || scalarString(item, "name") !== moduleName) return false;
		return item.commentBefore?.includes("Managed by @dsh-local/plugin-manager") === true;
	});
}

/** 写入一条明确的期望开关状态，不改动用户自有的补丁行。 */
async function writeDesiredState(location, configId, moduleName, enabled) {
	const document = await readDocument(location.filename);
	const sequence = document.contents;
	if (!isSeq(sequence)) throw new Error(`${location.filename} must contain a YAML sequence of patches`);
	let patch = ownedPatch(sequence, configId, moduleName);
	if (patch === void 0) {
		sequence.add(document.createNode({
			id: configId,
			name: moduleName,
			disabled: !enabled
		}));
		const added = sequence.items.at(-1);
		if (!isMap(added)) throw new Error("failed to create a plugin-manager YAML patch");
		patch = added;
		patch.commentBefore = OWNER_MARKER;
	} else {
		patch.set("disabled", !enabled);
	}
	await atomicWrite(location.filename, String(document));
}

async function atomicWrite(filename, content) {
	await mkdir(dirname(filename), { recursive: true });
	const temporary = join(dirname(filename), `.${basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
	await writeFile(temporary, content.endsWith("\n") ? content : `${content}\n`, "utf8");
	await rename(temporary, filename);
}
//#endregion

//#region 版本检测（npm registry，缓存 30 分钟）
const VERSION_CACHE = new Map();
const VERSION_TTL_MS = 30 * 60 * 1000;

async function fetchLatestVersion(packageName) {
	const cached = VERSION_CACHE.get(packageName);
	if (cached !== void 0 && Date.now() - cached.at < VERSION_TTL_MS) return cached.latest;
	let latest = null;
	try {
		const response = await fetch(`https://registry.npmjs.org/${packageName.replaceAll("/", "%2F")}`, {
			signal: AbortSignal.timeout(8000),
			headers: { accept: "application/vnd.npm.install-v1+json" }
		});
		if (response.ok) {
			const meta = await response.json();
			const tags = meta["dist-tags"];
			// @deepseek-ai/* 的正式发布走 next 轨道（latest 停留在占位版）
			latest = tags?.next ?? tags?.latest ?? null;
		}
	} catch {
		latest = null;
	}
	VERSION_CACHE.set(packageName, { at: Date.now(), latest });
	return latest;
}

/** 极简 semver 比较（含 -rc.N 预发布段）。返回 a>b ? 1 : a<b ? -1 : 0。 */
function compareVersions(a, b) {
	const [coreA, preA = null] = a.split("-", 2);
	const [coreB, preB = null] = b.split("-", 2);
	const cmp = compareCore(coreA, coreB);
	if (cmp !== 0) return cmp;
	if (preA === preB) return 0;
	if (preA === null) return 1;
	if (preB === null) return -1;
	return compareCore(preA, preB);
}

function compareCore(a, b) {
	const pa = a.split(".").map((part) => (part === "" ? 0 : Number(part)));
	const pb = b.split(".").map((part) => (part === "" ? 0 : Number(part)));
	const length = Math.max(pa.length, pb.length);
	for (let i = 0; i < length; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x > y ? 1 : -1;
	}
	return 0;
}
//#endregion

//#region 包信息解析（缓存）
const PACKAGE_CACHE = new Map();

function packageInfoOf(moduleName, baseUrl) {
	const key = `${baseUrl}\0${moduleName}`;
	const cached = PACKAGE_CACHE.get(key);
	if (cached !== void 0) return cached;
	let info = { installedVersion: null, isNpmPackage: false };
	try {
		const manifestPath = findPackageJSON(moduleName, baseUrl);
		if (manifestPath !== void 0) {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (manifest.name === moduleName) {
				info = {
					installedVersion: typeof manifest.version === "string" ? manifest.version : null,
					isNpmPackage: true
				};
			}
		}
	} catch {
		info = { installedVersion: null, isNpmPackage: false };
	}
	PACKAGE_CACHE.set(key, info);
	return info;
}
//#endregion

const FIBER_PHASE = {
	0: "pending",
	1: "loading",
	2: "active",
	3: "failed",
	4: null,
	5: "unloading"
};

const SELF_MODULE = "@dsh-local/plugin-manager";

/** 受保护条目：关闭后会导致管理入口/Web 表面/会话无法恢复。 */
const DEFAULT_PROTECTED_IDS = new Set([
	"api-gateway",
	"api-remotes",
	"connection",
	"client-hmr",
	"client-locale",
	"client-modules",
	"client-runtime",
	"cordis-host-runner",
	"hmr",
	"include",
	"locale",
	"modules",
	"runtime",
	"timer",
	"ui-settings",
	"ui-settings-general",
	"ui-settings-plugins",
	"web-runtime",
	"web-startup",
	"webserver",
	"plugin-manager-pro"
]);

/** 本地插件管理器宿主服务。 */
let PluginManagerPro = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators;
	let _refresh_decorators;
	let _setEnabled_decorators;
	return class PluginManagerPro extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			_refresh_decorators = [Remote("refresh")];
			_setEnabled_decorators = [Remote("setEnabled")];
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _refresh_decorators, {
				kind: "method",
				name: "refresh",
				static: false,
				private: false,
				access: {
					has: (obj) => "refresh" in obj,
					get: (obj) => obj.refresh
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setEnabled_decorators, {
				kind: "method",
				name: "setEnabled",
				static: false,
				private: false,
				access: {
					has: (obj) => "setEnabled" in obj,
					get: (obj) => obj.setEnabled
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["loader"];
		protectedIds;
		location;
		baseUrl;
		settleTimeoutMs;
		mutationTail = Promise.resolve();
		constructor(ctx, config = {}) {
			super(ctx, "pluginManagerPro");
			this.protectedIds = new Set([...DEFAULT_PROTECTED_IDS, ...(config.protectedEntries ?? [])]);
			this.settleTimeoutMs = config.settleTimeoutMs ?? 8000;
			const baseUrl = ctx.loader.ctx.baseUrl;
			if (baseUrl === void 0) throw new Error("@dsh-local/plugin-manager requires a file-backed Loader root");
			this.baseUrl = baseUrl;
			this.location = profileLocation(baseUrl);
		}
		/** 直接读 Loader，不维护第二份生命周期缓存。 */
		list() {
			return this.snapshot();
		}
		/** 强制重新检测所有 npm 包的最新版本后返回快照。 */
		async refresh() {
			const targets = new Set();
			for (const entry of this.ctx.loader.entries()) {
				if (entry.options.group) continue;
				const info = packageInfoOf(entry.options.name, this.baseUrl);
				if (info.isNpmPackage) targets.add(entry.options.name);
			}
			const names = [...targets];
			for (let i = 0; i < names.length; i += 4) {
				await Promise.all(names.slice(i, i + 4).map((name) => fetchLatestVersion(name)));
			}
			return this.snapshot();
		}
		/** 持久化并应用单个条目的期望开关状态。 */
		async setEnabled(entryId, enabled) {
			return await this.serialize(async () => {
				const entry = this.ctx.loader.resolve(entryId);
				const projected = this.project(entry);
				return {
					enabled,
					items: [await this.change(projected, enabled)],
					snapshot: this.snapshot()
				};
			});
		}
		snapshot() {
			const entries = [];
			for (const entry of this.ctx.loader.entries()) {
				if (entry.options.group) continue;
				entries.push(this.project(entry));
			}
			entries.sort((left, right) => {
				const order = { core: 0, recommended: 1, optional: 2 };
				const diff = (order[left.necessity] ?? 1) - (order[right.necessity] ?? 1);
				return diff !== 0 ? diff : left.configId.localeCompare(right.configId);
			});
			return {
				profileName: this.location.profileName,
				entries
			};
		}
		project(entry) {
			const self = entry.options.name === SELF_MODULE;
			const protectedById = this.protectedIds.has(entry.options.id);
			const protectsManager = this.isManagerAncestor(entry);
			const protectionReason = self ? "插件管理器不能停用自身。" : protectsManager ? "该条目承载插件管理器的生命周期。" : protectedById ? "该条目是 Web 管理界面/会话恢复所必需的。" : null;
			const fiber = entry.fiber;
			const configId = entry.options.id;
			const packageName = packageRoot(entry.options.name);
			const info = packageInfoOf(entry.options.name, this.baseUrl);
			const cacheEntry = VERSION_CACHE.get(packageName);
			const latest = cacheEntry?.latest ?? null;
			const installed = info.installedVersion;
			let needsUpdate = null;
			if (info.isNpmPackage && installed !== null && latest !== null) {
				needsUpdate = compareVersions(latest, installed) > 0;
			}
			return {
				entryId: entry.id,
				configId,
				moduleName: entry.options.name,
				packageName,
				description: DESCRIPTIONS[configId] ?? "（无简介）",
				necessity: NECESSITY[configId] ?? "recommended",
				enabled: !entry.disabled,
				phase: fiber === void 0 ? null : FIBER_PHASE[fiber.state] ?? null,
				error: fiber?.error === void 0 ? null : String(fiber.error),
				protected: protectionReason !== null,
				protectionReason,
				installedVersion: installed,
				latestVersion: latest,
				needsUpdate
			};
		}
		async change(entry, enabled) {
			if (entry.protected) return {
				entryId: entry.entryId,
				status: "skipped",
				message: entry.protectionReason
			};
			if (entry.enabled === enabled) return {
				entryId: entry.entryId,
				status: "unchanged",
				message: null
			};
			if (this.hasAmbiguousConfigId(entry)) return {
				entryId: entry.entryId,
				status: "failed",
				message: `配置 id ${entry.configId} 在该 Loader 树中不唯一。`
			};
			try {
				await writeDesiredState(this.location, entry.configId, entry.moduleName, enabled);
			} catch (error) {
				return {
					entryId: entry.entryId,
					status: "failed",
					message: error instanceof Error ? error.message : String(error)
				};
			}
			try {
				await this.waitFor(entry.entryId, enabled);
				return {
					entryId: entry.entryId,
					status: "changed",
					message: null
				};
			} catch (error) {
				return {
					entryId: entry.entryId,
					status: "restart-required",
					message: `期望状态已保存，但运行期未收敛。重启 ${this.location.profileName} profile 生效。${error instanceof Error ? error.message : String(error)}`
				};
			}
		}
		isManagerAncestor(candidate) {
			const manager = [...this.ctx.loader.entries()].find((entry) => entry.options.name === SELF_MODULE);
			if (manager === void 0) return false;
			let ancestor = manager.parent.ctx.fiber.entry;
			while (ancestor !== void 0) {
				if (ancestor === candidate) return true;
				ancestor = ancestor.parent.ctx.fiber.entry;
			}
			return false;
		}
		hasAmbiguousConfigId(target) {
			return this.snapshot().entries.filter((entry) => entry.configId === target.configId).length > 1;
		}
		async waitFor(entryId, enabled) {
			const deadline = Date.now() + this.settleTimeoutMs;
			while (Date.now() < deadline) {
				const entry = this.ctx.loader.resolve(entryId);
				if (!entry.disabled === enabled && entry._initTask === void 0 && entry._disposing === 0) return;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			throw new Error(`等待 ${entryId} 变为 ${enabled ? "启用" : "停用"} 超时。`);
		}
		async serialize(operation) {
			const previous = this.mutationTail;
			let release;
			this.mutationTail = new Promise((resolve) => {
				release = resolve;
			});
			await previous;
			try {
				return await operation();
			} finally {
				release();
			}
		}
	};
})();

/** 由模块名推导包级根名（用于分组/去重）。 */
function packageRoot(moduleName) {
	if (moduleName.startsWith("cordis:")) return moduleName;
	const parts = moduleName.split("/");
	if (moduleName.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : moduleName;
	return parts[0] ?? moduleName;
}

/** 装饰器运行时辅助（与 Typert 协议生成的宿主一致）。 */
function __esDecorate(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new Error("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		context.addInitializer = function(f) {
			if (done) throw new Error("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new Error("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
}

var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};

export { PluginManagerPro, PluginManagerPro as default };
