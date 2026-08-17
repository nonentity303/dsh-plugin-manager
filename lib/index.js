import { findPackageJSON } from "node:module";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isMap, isSeq, parseDocument } from "yaml";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { RESCUE_HTML } from "./rescue.js";
import { downloadUrl as downloadPluginUrl, cleanupDownload } from "./downloader.js";

/**
 * 本地插件管理器 —— 宿主端 v0.2。
 *
 * 列表投影：名称 / 功能简介 / 必要程度 / 启用状态（含运行期错误与版本更新检测）。
 * 更新：从「配置的更新源」（预填官方 npm 源）检测新版本，并用 pnpm 更新 profile 依赖。
 * 开关：把目标状态持久化到 profile 的 cordis.patch.yml（带归属标记的行），Loader 热重载生效。
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
	"plugin-manager-pro": "插件管理器：列表/简介/必要程度/状态/开关/更新"
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
const OWNER_MARKER = "Managed by dsh-plugin-manager-pro. Remove this row to return control to higher-level configuration.";

function profileLocation(baseUrl) {
	if (!baseUrl.startsWith("file:")) throw new Error("dsh-plugin-manager-pro requires a file-backed profile config");
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
		return item.commentBefore?.includes("Managed by dsh-plugin-manager-pro") === true;
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

//#region 更新源配置（侧车文件 <profileDir>/plugin-manager.json，预填官方源）
const SIDECAR_FILENAME = "plugin-manager.json";
const DEFAULT_SOURCES = [
	{ name: "官方源 (npm)", url: "https://registry.npmjs.org", enabled: true, official: true, type: "registry" },
	{ name: "插件超市 (dshfind)", url: "https://dshfind.com/zh/plugins", enabled: true, official: false, type: "dshfind" },
	{ name: "GitHub 官方仓库", url: "https://github.com/deepseek-ai/deepseek-harness", enabled: false, official: true, type: "github" },
	{ name: "npmmirror 镜像", url: "https://registry.npmmirror.com", enabled: false, official: false, type: "registry" }
];

/** 归一化源类型。 */
function normalizeSourceType(type) {
	return type === "github" || type === "dshfind" ? type : "registry";
}

function readSources(location) {
	try {
		const raw = readFileSync(join(location.directory, SIDECAR_FILENAME), "utf8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed?.sources)) {
			const sources = parsed.sources
				.filter((s) => s !== null && typeof s === "object" && typeof s.name === "string" && typeof s.url === "string" && /^https?:\/\//.test(s.url))
				.map((s) => ({
					name: (s.name.trim() || s.url).slice(0, 64),
					url: s.url.trim().replace(/\/+$/, ""),
					enabled: s.enabled !== false,
					official: s.official === true,
					type: normalizeSourceType(s.type)
				}));
			if (sources.length > 0) return sources;
		}
	} catch {
		// 侧车文件缺失或损坏 -> 使用默认源
	}
	return structuredClone(DEFAULT_SOURCES);
}

async function writeSources(location, sources) {
	await writeSidecar(location, { sources, rescue: readRescueConfig(location) });
}

/** 读取救援配置（侧车 rescue 字段）。 */
function readRescueConfig(location) {
	try {
		const raw = readFileSync(join(location.directory, SIDECAR_FILENAME), "utf8");
		const parsed = JSON.parse(raw);
		return { autoQuarantine: parsed?.rescue?.autoQuarantine === true };
	} catch {
		return { autoQuarantine: false };
	}
}

/** 全量写侧车（sources + rescue）。 */
async function writeSidecar(location, state) {
	await atomicWrite(join(location.directory, SIDECAR_FILENAME), JSON.stringify({ version: 1, sources: state.sources, rescue: state.rescue }, null, 2) + "\n");
}
//#endregion

//#region 版本检测（按源缓存 30 分钟；聚合结果缓存按包）
const VERSION_CACHE = new Map();
const VERSION_TTL_MS = 30 * 60 * 1000;
const LATEST_CACHE = new Map();

/** 统一返回 {version, repo}：repo 仅供 github/dshfind 源下载时使用。 */
async function fetchLatestVersion(packageName, source) {
	if (source.type === "github") return { version: await fetchLatestGithubVersion(packageName, source.url), repo: githubRepoOf(source.url) };
	if (source.type === "dshfind") return fetchLatestDshfindVersion(packageName);
	const key = `${source.url}\0${packageName}`;
	const cached = VERSION_CACHE.get(key);
	if (cached !== void 0 && Date.now() - cached.at < VERSION_TTL_MS) return { version: cached.latest, repo: null };
	let latest = null;
	try {
		const encoded = packageName.replaceAll("/", "%2F");
		const response = await fetch(`${source.url.replace(/\/+$/, "")}/${encoded}`, {
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
	VERSION_CACHE.set(key, { at: Date.now(), latest });
	return { version: latest, repo: null };
}

/** 从 GitHub 仓库 URL 解析 owner/repo。 */
function githubRepoOf(repoUrl) {
	const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)/.exec(repoUrl ?? "");
	return match === null ? null : `${match[1]}/${match[2]}`;
}

/** 拉取仓库最新 release（失败返回 null）。 */
async function fetchGitHubRelease(repo) {
	try {
		const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			signal: AbortSignal.timeout(8000),
			headers: { "user-agent": "dsh-plugin-manager", accept: "application/vnd.github+json" }
		});
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

/**
 * 解析 github / dshfind 源的下载链接：
 * 优先 release 资产 .tgz -> .torrent -> release 说明里的 magnet -> codeload 兜底。
 * magnet / .torrent 交给通用下载器走 P2P（webtorrent 或本机 aria2c）。
 */
async function resolveSourceDownloadUrl(source, best) {
	if (source.type === "github") {
		const repo = githubRepoOf(source.url) ?? best.repo;
		if (repo === null) return null;
		const release = await fetchGitHubRelease(repo);
		if (release !== null) {
			const tgz = (release.assets ?? []).find((a) => /\.(tgz|tar\.gz)$/i.test(a.name ?? ""));
			if (tgz?.browser_download_url) return tgz.browser_download_url;
			const torrent = (release.assets ?? []).find((a) => /\.torrent$/i.test(a.name ?? ""));
			if (torrent?.browser_download_url) return torrent.browser_download_url;
			const magnet = /(magnet:\?[^\s"'<>]+)/.exec(release.body ?? "");
			if (magnet) return magnet[1];
		}
		const [owner, repoName] = repo.split("/");
		return `https://codeload.github.com/${owner}/${repoName}/tar.gz/refs/tags/v${best.version}`;
	}
	if (source.type === "dshfind") {
		if (best.repo === null) return null;
		const release = await fetchGitHubRelease(best.repo);
		if (release !== null) {
			const tgz = (release.assets ?? []).find((a) => /\.(tgz|tar\.gz)$/i.test(a.name ?? ""));
			if (tgz?.browser_download_url) return tgz.browser_download_url;
			const torrent = (release.assets ?? []).find((a) => /\.torrent$/i.test(a.name ?? ""));
			if (torrent?.browser_download_url) return torrent.browser_download_url;
			const magnet = /(magnet:\?[^\s"'<>]+)/.exec(release.body ?? "");
			if (magnet) return magnet[1];
		}
		const [owner, repoName] = best.repo.split("/");
		return `https://codeload.github.com/${owner}/${repoName}/tar.gz/refs/tags/v${best.version}`;
	}
	return null;
}

/**
 * 插件超市（dshfind）源：本质是 GitHub dsh-plugin topic 的聚合。
 * 按包名搜索 topic 仓库（search API，10 次/分钟限流 —— 结果按包缓存），
 * 验证仓库根 package.json 的 name 匹配后取 releases/latest 版本。
 */
const DSFFIND_SEARCH_CACHE = new Map();
const DSFFIND_SEARCH_TTL_MS = 60 * 60 * 1000;

async function fetchLatestDshfindVersion(packageName) {
	const key = `dshfind\0${packageName}`;
	const cached = DSFFIND_SEARCH_CACHE.get(key);
	if (cached !== void 0 && Date.now() - cached.at < DSFFIND_SEARCH_TTL_MS) return { version: cached.latest, repo: cached.repo };
	let result = { version: null, repo: null };
	try {
		const query = encodeURIComponent(`topic:dsh-plugin ${packageName}`);
		const searchResponse = await fetch(`https://api.github.com/search/repositories?q=${query}&per_page=5&sort=updated`, {
			signal: AbortSignal.timeout(10000),
			headers: { "user-agent": "dsh-plugin-manager", accept: "application/vnd.github+json" }
		});
		if (searchResponse.ok) {
			const data = await searchResponse.json();
			const repos = data?.items ?? [];
			for (const repo of repos) {
				const fullName = repo?.full_name;
				if (typeof fullName !== "string") continue;
				try {
					const manifestResponse = await fetch(`https://raw.githubusercontent.com/${fullName}/HEAD/package.json`, {
						signal: AbortSignal.timeout(8000),
						headers: { "user-agent": "dsh-plugin-manager" }
					});
					if (!manifestResponse.ok) continue;
					const manifest = await manifestResponse.json();
					if (manifest?.name !== packageName) continue;
					const releaseResponse = await fetch(`https://api.github.com/repos/${fullName}/releases/latest`, {
						signal: AbortSignal.timeout(8000),
						headers: { "user-agent": "dsh-plugin-manager", accept: "application/vnd.github+json" }
					});
					if (!releaseResponse.ok) continue;
					const release = await releaseResponse.json();
					if (typeof release?.tag_name !== "string") continue;
					result = { version: release.tag_name.replace(/^v/, ""), repo: fullName };
					break;
				} catch {
					continue;
				}
			}
		}
	} catch {
		result = { version: null, repo: null };
	}
	DSFFIND_SEARCH_CACHE.set(key, { at: Date.now(), latest: result.version, repo: result.repo });
	return result;
}

/**
 * GitHub Releases 源：仓库根 package.json 的 name 必须等于被检查的包名；
 * 最新版本取 releases/latest 的 tag_name（去 v 前缀）。未认证 API 限流 60 次/小时，
 * 失败返回 null（不影响其它源）。
 */
async function fetchLatestGithubVersion(packageName, repoUrl) {
	const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)/.exec(repoUrl);
	if (match === null) return null;
	const owner = match[1];
	const repo = match[2];
	const key = `${repoUrl}\0${packageName}`;
	const cached = VERSION_CACHE.get(key);
	if (cached !== void 0 && Date.now() - cached.at < VERSION_TTL_MS) return cached.latest;
	let latest = null;
	try {
		const manifestResponse = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/package.json`, {
			signal: AbortSignal.timeout(8000),
			headers: { "user-agent": "dsh-plugin-manager" }
		});
		if (!manifestResponse.ok) return null;
		const manifest = await manifestResponse.json();
		if (manifest?.name !== packageName) return null;
		const releaseResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
			signal: AbortSignal.timeout(8000),
			headers: { "user-agent": "dsh-plugin-manager", accept: "application/vnd.github+json" }
		});
		if (!releaseResponse.ok) return null;
		const release = await releaseResponse.json();
		if (typeof release?.tag_name !== "string") return null;
		latest = release.tag_name.replace(/^v/, "");
	} catch {
		latest = null;
	}
	VERSION_CACHE.set(key, { at: Date.now(), latest });
	return latest;
}

/** 在所有启用的源中取最高版本及其来源。 */
async function fetchLatestAcross(packageName, sources) {
	let best = { version: null, sourceName: null, repo: null };
	for (const source of sources) {
		if (!source.enabled) continue;
		const result = await fetchLatestVersion(packageName, source);
		if (result?.version !== null && (best.version === null || compareVersions(result.version, best.version) > 0)) {
			best = { version: result.version, sourceName: source.name, repo: result.repo ?? null };
		}
	}
	return best;
}

/** 刷新一个包的最新版本聚合缓存。 */
async function refreshLatest(packageName, sources) {
	const best = await fetchLatestAcross(packageName, sources);
	LATEST_CACHE.set(packageName, { ...best, at: Date.now() });
	return best;
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

//#region 包信息解析（缓存）与 profile 依赖
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

function readProfileDeps(location) {
	try {
		const manifest = JSON.parse(readFileSync(join(location.directory, "package.json"), "utf8"));
		return manifest?.dependencies ?? {};
	} catch {
		return {};
	}
}

/**
 * 检查一个 bundle 是否可解析且声明 dsh.bundle（boot 的 loadProfile 会因
 * 不可解析的 bundle 直接失败 —— 启动前自检与自动救砖依赖此判定）。
 */
function resolveBundleExportsPatch(bundle, baseUrl, profileDir) {
	const rel = bundle.startsWith("@") ? bundle.split("/").slice(0, 2).join("/") : bundle.split("/")[0];
	const candidates = [];
	if (profileDir) candidates.push(join(profileDir, "node_modules", rel));
	try {
		const home = resolveDshHome();
		candidates.push(join(home, "profiles", "node_modules", rel));
	} catch { /* ignore */ }
	const npmRoot = typeof process !== "undefined" && process.env?.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : null;
	if (npmRoot) {
		candidates.push(join(npmRoot, rel));
		candidates.push(join(npmRoot, "@deepseek-ai", "dsh", "node_modules", rel));
	}
	for (const dir of candidates) {
		try {
			const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (manifest?.name === bundle && manifest?.dsh?.bundle?.patch !== void 0) return true;
		} catch { /* continue */ }
	}
	return false;
}
//#endregion

//#region pnpm 更新执行（异步 spawn，串行调用，5 分钟超时）
function spawnPnpm(args, cwd) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const done = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		let child;
		try {
			child = spawn("pnpm", args, {
				cwd,
				shell: process.platform === "win32",
				windowsHide: true,
				env: { ...process.env, NO_COLOR: "1" }
			});
		} catch (error) {
			done({ status: -1, error: String(error) });
			return;
		}
		const timer = setTimeout(() => {
			try { child.kill(); } catch { /* ignore */ }
			done({ status: -1, error: "pnpm 更新超时（5 分钟）" });
		}, 5 * 60 * 1000);
		child.stdout?.on("data", (d) => {
			stdout = (stdout + String(d)).slice(-4000);
		});
		child.stderr?.on("data", (d) => {
			stderr = (stderr + String(d)).slice(-4000);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			done({ status: -1, error: String(error) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const tail = (stdout + "\n" + stderr).trim().split("\n").slice(-8).join("\n");
			done({ status: code ?? -1, error: code === 0 ? null : tail || `pnpm 退出码 ${code}` });
		});
	});
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

/** 插件市场目录缓存（10 分钟 TTL）：awesome-dsh-plugin 精选目录 -> 规范化条目。 */
const CATALOG_CACHE = { at: 0, data: null };
const CATALOG_TTL = 10 * 60 * 1000;
const CATALOG_URL = "https://awesome-dsh-plugin.com/plugins.json";

const SELF_MODULE = "dsh-plugin-manager-pro";

/** 救援保护：即使救砖也不能禁用的条目（禁了管理/服务入口就全没了）。 */
const RESCUE_NEVER = new Set([
	"plugin-manager-pro",
	"timer",
	"include",
	"hmr",
	"loader",
	"webserver",
	"web-runtime",
	"web-startup",
	"connection",
	"client-runtime",
	"client-modules",
	"modules",
	"locale",
	"api-gateway",
	"typert",
	"typert-loader",
	"typert-gateway",
	"session",
	"agent",
	"agent-loop",
	"llm"
]);

/**
 * 架构保留条目：web-app 层刻意禁用、由其它层/浏览器端提供的行。
 * 启用它们会改变架构语义（重复注册、行为冲突）并触发树重载导致界面崩坏，
 * 因此一律禁止开关，并在 UI 标注「架构保留」。
 */
const ARCHIVED_IDS = new Set([
	"tool-bash",
	"tool-pwsh",
	"tool-jobs",
	"tool-fs",
	"tool-fs-search",
	"agent-instructions",
	"skill-filesystem",
	"skill-badge",
	"tool-skill",
	"plan-mode",
	"compaction-basic",
	"command-compact",
	"tool-subagent-control",
	"tool-subagent-list-agents",
	"tool-subagent",
	"tool-subagent-fork",
	"workflow-worker-thread",
	"tool-workflow",
	"tool-result-pruner",
	"tool-todo",
	"tool-goal",
	"tool-ralph",
	"tool-str-replace-editor",
	"tool-web",
	"bash-sandbox",
	"client-hmr",
	"hmr",
	"session-telemetry-otel",
	"ui-settings-plugin-inventory"
]);

/**
 * 受保护条目：关闭后会导致管理入口/Web 表面/会话无法恢复。
 * UI_CRITICAL：浏览器界面骨架/必需交互插件 —— 停用会直接导致界面崩坏（布局塌陷、
 * 对话页/侧栏/设置消失），因此一律禁止开关。
 */
const UI_CRITICAL_IDS = new Set([
	"client-connection",
	"ui-layout",
	"ui-sidebar",
	"ui-conversation",
	"ui-theme",
	"ui-cordis",
	"ui-tool",
	"ui-input-trigger",
	"ui-workspace",
	"ui-commands",
	"ui-settings-models",
	"ui-permission"
]);

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
	let _getSources_decorators;
	let _setSources_decorators;
	let _setEnabled_decorators;
	let _resetToggles_decorators;
	let _update_decorators;
	let _diagnose_decorators;
	let _quarantine_decorators;
	let _repairHarness_decorators;
	let _restartHarness_decorators;
	let _uninstallPackages_decorators;
	let _getRescueConfig_decorators;
	let _setRescueConfig_decorators;
	let _getDownloadConfig_decorators;
	let _checkDownloads_decorators;
	let _resolveDownloadUrl_decorators;
	let _verifyProfile_decorators;
	let _fixProfile_decorators;
	let _updateBrowser_decorators;
	let _marketCatalog_decorators;
	let _marketInstall_decorators;
	return class PluginManagerPro extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			_refresh_decorators = [Remote("refresh")];
			_getSources_decorators = [Remote("getSources")];
			_setSources_decorators = [Remote("setSources")];
			_setEnabled_decorators = [Remote("setEnabled")];
			_resetToggles_decorators = [Remote("resetToggles")];
			_update_decorators = [Remote("update")];
			_diagnose_decorators = [Remote("diagnose")];
			_quarantine_decorators = [Remote("quarantine")];
			_repairHarness_decorators = [Remote("repairHarness")];
			_restartHarness_decorators = [Remote("restartHarness")];
			_uninstallPackages_decorators = [Remote("uninstallPackages")];
			_getRescueConfig_decorators = [Remote("getRescueConfig")];
			_setRescueConfig_decorators = [Remote("setRescueConfig")];
			_getDownloadConfig_decorators = [Remote("getDownloadConfig")];
			_checkDownloads_decorators = [Remote("checkDownloads")];
			_resolveDownloadUrl_decorators = [Remote("resolveDownloadUrl")];
			_verifyProfile_decorators = [Remote("verifyProfile")];
			_fixProfile_decorators = [Remote("fixProfile")];
			_updateBrowser_decorators = [Remote("updateBrowser")];
			_marketCatalog_decorators = [Remote("marketCatalog")];
			_marketInstall_decorators = [Remote("marketInstall")];
			for (const [decorators, name] of [
				[_list_decorators, "list"],
				[_refresh_decorators, "refresh"],
				[_getSources_decorators, "getSources"],
				[_setSources_decorators, "setSources"],
				[_setEnabled_decorators, "setEnabled"],
				[_resetToggles_decorators, "resetToggles"],
				[_update_decorators, "update"],
				[_diagnose_decorators, "diagnose"],
				[_quarantine_decorators, "quarantine"],
				[_repairHarness_decorators, "repairHarness"],
				[_restartHarness_decorators, "restartHarness"],
				[_uninstallPackages_decorators, "uninstallPackages"],
				[_getRescueConfig_decorators, "getRescueConfig"],
				[_setRescueConfig_decorators, "setRescueConfig"],
				[_getDownloadConfig_decorators, "getDownloadConfig"],
				[_checkDownloads_decorators, "checkDownloads"],
				[_resolveDownloadUrl_decorators, "resolveDownloadUrl"],
				[_verifyProfile_decorators, "verifyProfile"],
				[_fixProfile_decorators, "fixProfile"],
				[_updateBrowser_decorators, "updateBrowser"],
				[_marketCatalog_decorators, "marketCatalog"],
				[_marketInstall_decorators, "marketInstall"]
			]) {
				__esDecorate(this, null, decorators, {
					kind: "method",
					name,
					static: false,
					private: false,
					access: {
						has: (obj) => name in obj,
						get: (obj) => obj[name]
					},
					metadata: _metadata
				}, null, _instanceExtraInitializers);
			}
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
		sources;
		profileDeps;
		mutationTail = Promise.resolve();
		constructor(ctx, config = {}) {
			super(ctx, "pluginManagerPro");
			this.protectedIds = new Set([...DEFAULT_PROTECTED_IDS, ...UI_CRITICAL_IDS, ...(config.protectedEntries ?? [])]);
			this.settleTimeoutMs = config.settleTimeoutMs ?? 8000;
			const baseUrl = ctx.loader.ctx.baseUrl;
			if (baseUrl === void 0) throw new Error("dsh-plugin-manager-pro requires a file-backed Loader root");
			this.baseUrl = baseUrl;
			this.location = profileLocation(baseUrl);
			this.sources = readSources(this.location);
			this.profileDeps = readProfileDeps(this.location);
			this.rescueConfig = readRescueConfig(this.location);
			// 自动隔离：监听 fiber 状态变化，失败的条目自动禁用（默认关闭，setRescueConfig 开启）
			ctx.on("internal/plugin", (fiber) => {
				if (!this.rescueConfig?.autoQuarantine) return;
				const entry = fiber?.entry;
				if (entry === void 0 || entry.options.group) return;
				if (fiber.state !== 3 && fiber.error === void 0) return;
				const configId = entry.options.id;
				if (RESCUE_NEVER.has(configId)) return;
				void this.serialize(async () => {
					try {
						const p = this.project(entry);
						if (!p.enabled) return;
						await writeDesiredState(this.location, configId, entry.options.name, false);
						this.log("autoQuarantine", `disabled failed ${configId}`);
					} catch (error) {
						this.log("autoQuarantine", `${configId} failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				});
			});
			// 注册 /rescue 独立救援页（不依赖任何客户端插件/设置页）
			// 用 ctx.inject 等待 webServer 服务就绪（激活是并发的，constructor 时可能还没注册）；
			// headless 环境没有 webServer，失败回调静默跳过。
			ctx.inject(["webServer"], (webCtx) => {
				webCtx.effect(() => webCtx.webServer.register({
					kind: "prefix",
					path: "/rescue",
					handler: (req, res) => this.serveRescue(req, res)
				}), "plugin-manager: rescue page");
			}, () => {
				this.log("rescue", "webServer unavailable - rescue page not registered");
			});
		}
		/** 直接读 Loader，不维护第二份生命周期缓存。 */
		list() {
			return this.snapshot();
		}
		/** 返回当前快照（含更新源列表）。 */
		getSources() {
			return this.snapshot();
		}
		/** 校验并保存更新源列表，随后立即重新检测所有包的最新版本。 */
		async setSources(sources) {
			return await this.serialize(async () => {
				const seen = new Set();
				const normalized = [];
				for (const s of sources ?? []) {
					if (s === null || typeof s !== "object" || typeof s.name !== "string" || typeof s.url !== "string") continue;
					const url = s.url.trim().replace(/\/+$/, "");
					if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
					seen.add(url);
					normalized.push({
						name: (s.name.trim() || url).slice(0, 64),
						url,
						enabled: s.enabled !== false,
						official: s.official === true,
						type: normalizeSourceType(s.type)
					});
				}
				this.sources = normalized;
				VERSION_CACHE.clear();
				LATEST_CACHE.clear();
				await writeSources(this.location, normalized);
				await this.refresh();
				return this.snapshot();
			});
		}
		/** 强制重新检测所有 npm 包（所有启用源）后返回快照。 */
		async refresh() {
			const targets = new Set();
			for (const entry of this.ctx.loader.entries()) {
				if (entry.options.group) continue;
				const info = packageInfoOf(entry.options.name, this.baseUrl);
				if (info.isNpmPackage) targets.add(entry.options.name);
			}
			const names = [...targets];
			for (let i = 0; i < names.length; i += 4) {
				await Promise.all(names.slice(i, i + 4).map((name) => refreshLatest(name, this.sources)));
			}
			return this.snapshot();
		}
		/** 持久化并应用单个条目的期望开关状态。 */
		async setEnabled(entryId, enabled) {
			return await this.serialize(async () => {
				const entry = this.ctx.loader.resolve(entryId);
				const projected = this.project(entry);
				const items = [await this.change(projected, enabled)];
				this.log("setEnabled", `${entryId} -> ${enabled ? "enabled" : "disabled"} (${items[0].status})`);
				return {
					enabled,
					items,
					snapshot: this.snapshot()
				};
			});
		}
		/** 清空本管理器写入的所有开关行（还原 cordis.patch.yml），供界面崩坏后自救。 */
		async resetToggles() {
			return await this.serialize(async () => {
				const document = await readDocument(this.location.filename);
				const sequence = document.contents;
				if (!isSeq(sequence)) throw new Error(`${this.location.filename} must contain a YAML sequence of patches`);
				const remaining = sequence.items.filter((item) => {
					if (!isMap(item)) return true;
					const id = scalarString(item, "id");
					const name = scalarString(item, "name");
					if (id === void 0 && name === void 0) return true;
					return !(item.commentBefore?.includes("Managed by dsh-plugin-manager-pro") === true);
				});
				const removed = sequence.items.length - remaining.length;
				if (removed > 0) {
					document.contents.items = remaining;
					await atomicWrite(this.location.filename, String(document));
					this.log("resetToggles", `removed ${removed} manager-owned rows`);
				} else {
					this.log("resetToggles", "nothing to reset");
				}
				return this.snapshot();
			});
		}
		/** 诊断：扫描加载失败/运行期错误的条目。 */
		diagnose() {
			const issues = [];
			for (const entry of this.ctx.loader.entries()) {
				if (entry.options.group) continue;
				const fiber = entry.fiber;
				const failed = fiber?.state === 3 || fiber?.error !== void 0;
				if (!failed) continue;
				const p = this.project(entry);
				const spec = this.profileDeps[p.packageName];
				const canUninstall = spec !== void 0 && !/^(file:|link:|workspace:)/.test(spec) && p.packageName !== SELF_MODULE;
				issues.push({
					entryId: p.entryId,
					configId: p.configId,
					moduleName: p.moduleName,
					phase: p.phase,
					error: p.error,
					suggestion: RESCUE_NEVER.has(p.configId) || p.configId === "plugin-manager-pro" ? "none" : "disable",
					canUninstall
				});
			}
			this.log("diagnose", `issues=${issues.length}`);
			return { issues, snapshot: this.snapshot() };
		}
		/** 救援隔离：强制禁用指定条目（绕过常规保护，仅排除救援保护条目）。 */
		async quarantine(entryIds) {
			return await this.serialize(async () => {
				const items = [];
				for (const entryId of entryIds ?? []) {
					let entry;
					try {
						entry = this.ctx.loader.resolve(entryId);
					} catch {
						items.push({ entryId, status: "skipped", message: "条目不存在。" });
						continue;
					}
					const p = this.project(entry);
					if (RESCUE_NEVER.has(p.configId)) {
						items.push({ entryId, status: "skipped", message: "救援保护条目，不可禁用。" });
						continue;
					}
					if (!p.enabled) {
						items.push({ entryId, status: "skipped", message: "已是禁用状态。" });
						continue;
					}
					try {
						await writeDesiredState(this.location, p.configId, p.moduleName, false);
						await this.waitFor(entryId, false);
						items.push({ entryId, status: "disabled", message: null });
						this.log("quarantine", `disabled ${p.configId}`);
					} catch (error) {
						items.push({ entryId, status: "failed", message: error instanceof Error ? error.message : String(error) });
					}
				}
				return { items, snapshot: this.snapshot() };
			});
		}
		/** 一键救砖：重置管理器行 + 隔离全部失败条目 + 清缓存。 */
		async repairHarness() {
			return await this.serialize(async () => {
				const actions = [];
				// 1) 重置所有管理器写入的开关行
				const document = await readDocument(this.location.filename);
				const sequence = document.contents;
				if (isSeq(sequence)) {
					const remaining = sequence.items.filter((item) => {
						if (!isMap(item)) return true;
						const id = scalarString(item, "id");
						const name = scalarString(item, "name");
						if (id === void 0 && name === void 0) return true;
						return !(item.commentBefore?.includes("Managed by dsh-plugin-manager-pro") === true);
					});
					const removed = sequence.items.length - remaining.length;
					if (removed > 0) {
						document.contents.items = remaining;
						await atomicWrite(this.location.filename, String(document));
						actions.push({ action: "reset-toggles", detail: `清除了 ${removed} 条管理器开关行` });
					}
				}
				// 2) 隔离所有失败条目
				const failed = [];
				for (const entry of this.ctx.loader.entries()) {
					if (entry.options.group) continue;
					const fiber = entry.fiber;
					if (fiber?.state !== 3 && fiber?.error === void 0) continue;
					const p = this.project(entry);
					if (p.enabled && !RESCUE_NEVER.has(p.configId)) failed.push(p);
				}
				for (const p of failed) {
					try {
						await writeDesiredState(this.location, p.configId, p.moduleName, false);
						actions.push({ action: "quarantine", detail: `禁用了问题插件 ${p.configId}` });
						this.log("repairHarness", `quarantined ${p.configId}`);
					} catch (error) {
						actions.push({ action: "quarantine", detail: `${p.configId} 禁用失败: ${error instanceof Error ? error.message : String(error)}` });
					}
				}
				// 3) 清缓存
				PACKAGE_CACHE.clear();
				VERSION_CACHE.clear();
				LATEST_CACHE.clear();
				actions.push({ action: "clear-cache", detail: "已清空包/版本缓存" });
				this.profileDeps = readProfileDeps(this.location);
				this.log("repairHarness", `actions=${actions.length}`);
				return { actions, restartCommand: "dsh web", snapshot: this.snapshot() };
			});
		}
		/** 重启引擎：生成过渡脚本 → 旧进程退出 → 过渡脚本 2 秒后拉起新实例。 */
		async restartHarness() {
			const tmp = join(tmpdir(), `dsh-restart-${process.pid}-${randomUUID()}.cjs`);
			const argv = process.argv.slice(1).map((arg) => String(arg));
			const bridge = `
const { spawn } = require("node:child_process");
setTimeout(() => {
  const child = spawn(process.execPath, ${JSON.stringify(argv)}, { detached: true, stdio: "ignore", cwd: ${JSON.stringify(process.cwd())}, env: process.env, windowsHide: true });
  child.unref();
  process.exit(0);
}, 2000);
`;
			try {
				writeFileSync(tmp, bridge, "utf8");
				const child = spawn(process.execPath, [tmp], { detached: true, stdio: "ignore", windowsHide: true });
				child.unref();
				this.log("restartHarness", `bridge ${tmp} spawned; exiting in 500ms`);
				setTimeout(() => {
					try {
						unlinkSync(tmp);
					} catch {
						// 忽略清理失败
					}
					process.exit(0);
				}, 500);
				return { accepted: true, message: "引擎正在重启：当前进程将退出，新实例约 2 秒后启动。若浏览器断连，请稍后刷新页面。" };
			} catch (error) {
				return { accepted: false, message: error instanceof Error ? error.message : String(error) };
			}
		}
		/** 卸载 profile 依赖（从 package.json 移除依赖与 bundles 条目）。 */
		async uninstallPackages(packageNames) {
			return await this.serialize(async () => {
				const items = [];
				for (const packageName of packageNames ?? []) {
					const spec = this.profileDeps[packageName];
					if (spec === void 0) {
						items.push({ packageName, status: "not-managed", message: "不是本 profile 的依赖，无法卸载。" });
						continue;
					}
					if (packageName === SELF_MODULE) {
						items.push({ packageName, status: "not-managed", message: "不能卸载管理器自身。" });
						continue;
					}
					const result = await spawnPnpm(["remove", packageName], this.location.directory);
					if (result.status !== 0) {
						items.push({ packageName, status: "failed", message: result.error ?? "pnpm 卸载失败" });
						continue;
					}
					try {
						const manifestPath = join(this.location.directory, "package.json");
						const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
						const bundles = manifest?.dsh?.profile?.bundles ?? [];
						const next = bundles.filter((b) => b !== packageName);
						if (next.length !== bundles.length) {
							manifest.dsh.profile.bundles = next;
							writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
						}
					} catch (error) {
						items.push({ packageName, status: "failed", message: `已移除依赖但更新 bundles 失败: ${error instanceof Error ? error.message : String(error)}` });
						continue;
					}
					PACKAGE_CACHE.clear();
					this.profileDeps = readProfileDeps(this.location);
					this.log("uninstallPackages", `removed ${packageName}`);
					items.push({ packageName, status: "removed", message: "已卸载，重启 profile 后生效。" });
				}
				return { items, snapshot: this.snapshot() };
			});
		}
		/** 设置救援配置（自动隔离开关）。 */
		async setRescueConfig(config) {
			return await this.serialize(async () => {
				this.rescueConfig = { autoQuarantine: config?.autoQuarantine === true };
				await writeSidecar(this.location, { sources: this.sources, rescue: this.rescueConfig });
				this.log("setRescueConfig", `autoQuarantine=${this.rescueConfig.autoQuarantine}`);
				return this.snapshot();
			});
		}
		/** 读取救援配置。 */
		getRescueConfig() {
			return { autoQuarantine: this.rescueConfig?.autoQuarantine === true };
		}
		/** /rescue 救援页（独立 HTML，不依赖任何客户端插件）。 */
		serveRescue(req, res) {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405);
				res.end();
				return;
			}
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store"
			});
			res.end(RESCUE_HTML);
		}
		//#region 下载目录自动拾取（浏览器/NDM/aria2 等下载到该目录后自动安装）
		/** 下载目录：$DSH_HOME/downloads。 */
		downloadDir() {
			return join(resolveDshHome(), "downloads");
		}
		/** 返回下载目录信息（供 UI 提示）。 */
		getDownloadConfig() {
			return { dir: this.downloadDir() };
		}
		/** 扫描下载目录：新出现的 tarball 自动 pnpm add 安装。 */
		async checkDownloads() {
			return await this.serialize(async () => {
				const { readdirSync } = require("node:fs");
				const dir = this.downloadDir();
				const installed = [];
				const failed = [];
				let files = [];
				try {
					mkdirSync(dir, { recursive: true });
					files = readdirSync(dir).filter((name) => /\.(tgz|tar\.gz|zip)$/i.test(name));
				} catch (error) {
					return { installed, failed, message: `下载目录不可用: ${error instanceof Error ? error.message : String(error)}` };
				}
				for (const name of files) {
					const file = join(dir, name);
					const stamp = join(dir, `.${name}.installed`);
					if (existsSync(stamp)) continue;
					const result = await spawnPnpm(["add", file], this.location.directory);
					if (result.status === 0) {
						writeFileSync(stamp, new Date().toISOString(), "utf8");
						installed.push(name);
						this.log("checkDownloads", `installed ${name}`);
					} else {
						failed.push({ name, message: result.error ?? "安装失败" });
					}
				}
				return { installed, failed, message: null };
			});
		}
		/** 解析某包在 github/dshfind 源的下载链接（供浏览器/NDM 手动下载）。 */
		async resolveDownloadUrl(packageName) {
			const best = LATEST_CACHE.get(packageName);
			const info = packageInfoOf(packageName, this.baseUrl);
			const source = best !== void 0 && best.sourceName !== null
				? this.sources.find((s) => s.enabled && s.name === best.sourceName)
				: void 0;
			if (source === void 0 || best === void 0) return { url: null, message: "没有可用的更新源信息，请先刷新检查更新。" };
			const url = await resolveSourceDownloadUrl(source, best);
			if (url === null) return { url: null, message: "无法解析下载链接（该源未提供发布资产）。" };
			return { url, message: null, sourceName: source.name, installedVersion: info.installedVersion, latestVersion: best.version };
		}
		//#endregion
		//#region 启动前自检（自动化救砖：坏 bundle 会在 boot 时让引擎起不来）
		/** 校验 profile：bundles 可解析性 + patch 可解析性。 */
		verifyProfile() {
			const issues = [];
			const manifestPath = join(this.location.directory, "package.json");
			let manifest;
			try {
				manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			} catch (error) {
				return { ok: false, issues: [{ kind: "manifest", name: "package.json", reason: `无法解析: ${error instanceof Error ? error.message : String(error)}` }] };
			}
			const bundles = manifest?.dsh?.profile?.bundles ?? [];
			for (const bundle of bundles) {
				if (!resolveBundleExportsPatch(bundle, this.baseUrl, this.location.directory)) {
					issues.push({ kind: "bundle", name: bundle, reason: "bundle 不可解析（包未安装或未声明 dsh.bundle），引擎将无法启动。" });
				}
			}
			const patchPath = join(this.location.directory, PATCH_FILENAME);
			if (existsSync(patchPath)) {
				try {
					const { parse } = require("yaml");
					if (!Array.isArray(parse(readFileSync(patchPath, "utf8")))) {
						issues.push({ kind: "patch", name: PATCH_FILENAME, reason: "不是顶层数组（boot 会失败）。" });
					}
				} catch (error) {
					issues.push({ kind: "patch", name: PATCH_FILENAME, reason: `YAML 解析失败: ${error instanceof Error ? error.message : String(error)}` });
				}
			}
			this.log("verifyProfile", `bundles=${bundles.length} issues=${issues.length}`);
			return { ok: issues.length === 0, issues };
		}
		/** 自动救砖：隔离坏 bundle（备份 -> 从 bundles/dependencies 移除）并修复坏 patch。 */
		async fixProfile() {
			return await this.serialize(async () => {
				const actions = [];
				const manifestPath = join(this.location.directory, "package.json");
				let manifest;
				try {
					manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				} catch (error) {
					return { ok: false, actions, message: `package.json 无法解析: ${error instanceof Error ? error.message : String(error)}` };
				}
				const bundles = manifest?.dsh?.profile?.bundles ?? [];
				const broken = bundles.filter((bundle) => !resolveBundleExportsPatch(bundle, this.baseUrl, this.location.directory));
				if (broken.length > 0) {
					const backup = `${manifestPath}.rescue-bak-${Date.now()}`;
					writeFileSync(backup, JSON.stringify(manifest, null, 2) + "\n", "utf8");
					manifest.dsh.profile.bundles = bundles.filter((b) => !broken.includes(b));
					for (const b of broken) {
						if (manifest.dependencies?.[b] !== void 0) delete manifest.dependencies[b];
					}
					writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
					actions.push({ action: "quarantine-bundles", detail: `已隔离 ${broken.join(", ")}（备份 ${backup}）` });
					this.log("fixProfile", `quarantined bundles: ${broken.join(", ")}`);
				}
				const patchPath = join(this.location.directory, PATCH_FILENAME);
				if (existsSync(patchPath)) {
					let patchOk = true;
					try {
						const { parse } = require("yaml");
						if (!Array.isArray(parse(readFileSync(patchPath, "utf8")))) patchOk = false;
					} catch {
						patchOk = false;
					}
					if (!patchOk) {
						const backup = `${patchPath}.rescue-bak-${Date.now()}`;
						writeFileSync(backup, readFileSync(patchPath, "utf8"), "utf8");
						writeFileSync(patchPath, "# restored by plugin-manager rescue\n[]\n", "utf8");
						actions.push({ action: "restore-patch", detail: `cordis.patch.yml 已还原为空（备份 ${backup}）` });
						this.log("fixProfile", "restored cordis.patch.yml");
					}
				}
				this.profileDeps = readProfileDeps(this.location);
				if (actions.length === 0) actions.push({ action: "none", detail: "未发现问题" });
				return { ok: true, actions, message: actions.length > 1 ? "已修复，重启引擎后生效。" : null };
			});
		}
		//#endregion
		/** 更新（内置下载器路径，registry 源 pnpm 直装；github/dshfind 走通用下载器）。 */
		async update(packageNames) {
			return await this.serialize(async () => {
				const items = [];
				for (const packageName of packageNames ?? []) {
					const item = await this.updateOne(packageName);
					this.log("update", `${packageName} -> ${item.status}`);
					items.push(item);
				}
				this.profileDeps = readProfileDeps(this.location);
				return { items, snapshot: this.snapshot() };
			});
		}
		/** 浏览器下载模式（优先）：解析每个包的下载链接，由浏览器/NDM 下载后自动拾取安装。 */
		async updateBrowser(packageNames) {
			return await this.serialize(async () => {
				const items = [];
				for (const packageName of packageNames ?? []) {
					const spec = this.profileDeps[packageName];
					if (spec === void 0) {
						items.push({ packageName, status: "not-managed", url: null, sourceName: null, installedVersion: null, latestVersion: null, message: "不是本 profile 的依赖（随 dsh 安装提供）。" });
						continue;
					}
					if (/^(file:|link:|workspace:)/.test(spec)) {
						items.push({ packageName, status: "not-managed", url: null, sourceName: null, installedVersion: null, latestVersion: null, message: "本地包（file:/link:），请用 dsh plugin add 更新。" });
						continue;
					}
					const installed = packageInfoOf(packageName, this.baseUrl).installedVersion;
					let best = LATEST_CACHE.get(packageName);
					if (best === void 0 || best.version === null) {
						best = await refreshLatest(packageName, this.sources);
					}
					if (best.version === null) {
						items.push({ packageName, status: "failed", url: null, sourceName: null, installedVersion: installed, latestVersion: null, message: "无法从启用的更新源获取版本（离线或源不可达）。" });
						continue;
					}
					if (installed !== null && compareVersions(best.version, installed) <= 0) {
						items.push({ packageName, status: "up-to-date", url: null, sourceName: null, installedVersion: installed, latestVersion: best.version, message: null });
						continue;
					}
					const source = this.sources.find((s) => s.enabled && s.name === best.sourceName) ?? this.sources.find((s) => s.enabled);
					if (source === void 0) {
						items.push({ packageName, status: "failed", url: null, sourceName: null, installedVersion: installed, latestVersion: best.version, message: "没有启用的更新源。" });
						continue;
					}
					if (source.type === "registry") {
						// registry 源直接用内置 pnpm 路径更可靠
						const item = await this.updateOne(packageName);
						items.push({ packageName, status: item.status === "updated" ? "up-to-date" : item.status === "failed" ? "failed" : "need-download", url: null, sourceName: source.name, installedVersion: item.installedVersion, latestVersion: item.latestVersion, message: item.message });
						continue;
					}
					const url = await resolveSourceDownloadUrl(source, best);
					if (url === null) {
						items.push({ packageName, status: "failed", url: null, sourceName: source.name, installedVersion: installed, latestVersion: best.version, message: "无法解析下载链接（该源未提供发布资产）。" });
						continue;
					}
					this.log("updateBrowser", `${packageName} -> ${url.slice(0, 120)}`);
					items.push({ packageName, status: "need-download", url, sourceName: source.name, installedVersion: installed, latestVersion: best.version, message: "已生成下载链接，请用浏览器/NDM 下载后自动安装。" });
				}
				return { items, snapshot: this.snapshot() };
			});
		}
		//#region 插件市场（轻量：awesome-dsh-plugin 精选目录 + 一键安装）
		/** 规范化 awesome-dsh-plugin 目录条目。 */
		normalizeCatalogEntry(raw) {
			const url = typeof raw?.url === "string" ? raw.url : "";
			const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/.+)?\/?$/.exec(url);
			return {
				name: typeof raw?.name === "string" ? raw.name : "",
				owner: repo ? repo[1].split("/")[0] : "",
				url,
				npm: typeof raw?.npm === "string" && raw.npm !== "" ? raw.npm : null,
				category: typeof raw?.category === "string" && raw.category !== "" ? raw.category : "other",
				description: raw?.description && typeof raw.description === "object" ? raw.description : null,
				stars: typeof raw?.stars === "number" ? raw.stars : null,
				added: typeof raw?.added === "string" && raw.added !== "" ? raw.added : null
			};
		}
		/** 规范化 GitHub 搜索兜底条目。 */
		normalizeGithubEntry(repo) {
			const fullName = repo?.full_name ?? "";
			const [owner = ""] = fullName.split("/");
			return {
				name: fullName,
				owner,
				url: fullName ? `https://github.com/${fullName}` : "",
				npm: null,
				category: "github",
				description: typeof repo?.description === "string" ? { en: repo.description } : null,
				stars: typeof repo?.stargazers_count === "number" ? repo.stargazers_count : null,
				added: typeof repo?.updated_at === "string" ? repo.updated_at.slice(0, 10) : null
			};
		}
		/**
		 * 拉取插件市场目录（一次全量，客户端本地过滤/分页）。
		 * 数据源：awesome-dsh-plugin 精选目录（就是 dshfind 的收录池），
		 * 带分类/本地化描述/npm 包名/stars/收录日期；在线失败时兜底 GitHub
		 * topic:dsh-plugin 搜索（限流 10/min —— 目录已缓存 10 分钟，极少触发）。
		 * @returns {source, updated, count, categories, items}
		 */
		marketCatalog() {
			return this.serialize(async () => {
				const now = Date.now();
				if (CATALOG_CACHE.data !== null && now - CATALOG_CACHE.at < CATALOG_TTL) {
					const cached = CATALOG_CACHE.data;
					return { source: "cache", updated: cached.updated, count: cached.items.length, categories: cached.categories, items: cached.items };
				}
				try {
					const response = await fetch(CATALOG_URL, {
						signal: AbortSignal.timeout(8000),
						headers: { "user-agent": "dsh-plugin-manager", accept: "application/json" }
					});
					if (response.ok) {
						const data = await response.json();
						const rawItems = Array.isArray(data?.plugins) ? data.plugins : null;
						if (rawItems !== null && rawItems.length > 0) {
							const items = rawItems.map((raw) => this.normalizeCatalogEntry(raw)).filter((item) => item.name !== "");
							CATALOG_CACHE.at = now;
							CATALOG_CACHE.data = { updated: typeof data?.updated === "string" ? data.updated : null, categories: data?.categories ?? null, items };
							this.log("marketCatalog", `loaded ${items.length} plugins from awesome-dsh-plugin (updated=${data?.updated ?? "?"})`);
							return { source: "live", updated: CATALOG_CACHE.data.updated, count: items.length, categories: CATALOG_CACHE.data.categories, items };
						}
					}
				} catch { /* 在线目录失败 -> GitHub 搜索兜底 */ }
				try {
					const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent("topic:dsh-plugin")}&sort=stars&order=desc&per_page=50`, {
						signal: AbortSignal.timeout(10000),
						headers: { "user-agent": "dsh-plugin-manager", accept: "application/vnd.github+json" }
					});
					if (response.ok) {
						const data = await response.json();
						const items = (data?.items ?? []).map((repo) => this.normalizeGithubEntry(repo)).filter((item) => item.name !== "");
						CATALOG_CACHE.at = now;
						CATALOG_CACHE.data = { updated: null, categories: null, items };
						return { source: "github-fallback", updated: null, count: items.length, categories: null, items };
					}
				} catch { /* 全部失败 */ }
				return { source: "error", updated: null, count: 0, categories: null, items: [] };
			});
		}
		/**
		 * 市场一键安装。target 来自目录条目（客户端传入），host 侧白名单：
		 * npm 包名 -> registry 直装（预构建 tarball，最可靠）；否则 GitHub 下载
		 * （release .tgz -> codeload 兜底）。带 pnpm 11 陷阱恢复（hoist 漂移重建、
		 * minimumReleaseAge 跳过）与装后防砖校验（无 dsh 清单/产物自动卸载）。
		 * dryRun 只解析不安装。
		 */
		marketInstall(target, dryRun) {
			return this.serialize(async () => {
				const name = typeof target?.name === "string" ? target.name : "";
				const url = typeof target?.url === "string" ? target.url : "";
				if (name === "") return { status: "failed", packageName: null, url: null, method: null, message: "缺少市场条目。" };
				const npm = typeof target?.npm === "string" && /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(target.npm) ? target.npm : null;
				const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/.+)?\/?$/.exec(url);
				if (npm === null && repo === null) {
					return { status: "failed", packageName: null, url: null, method: null, message: `不支持的来源：${url.slice(0, 120)}` };
				}
				const method = npm !== null ? "npm" : "github";
				const packageName = npm ?? name;
				// 1) 已安装检测（loader 条目 + profile 依赖）
				const installedNames = new Set(Object.keys(this.profileDeps));
				for (const entry of this.ctx.loader.entries()) {
					if (!entry.options.group) installedNames.add(packageRoot(entry.options.name));
				}
				if (installedNames.has(packageName)) {
					return { status: "already-installed", packageName, url: npm !== null ? `https://registry.npmjs.org/${npm}` : url, method, message: `${packageName} 已安装。` };
				}
				// 2) GitHub 路径：先读仓库清单拿真实包名 + dsh 预检（无 dsh.bundle/client 直接拒绝）
				let githubManifest = null;
				if (npm === null) {
					try {
						const response = await fetch(`https://raw.githubusercontent.com/${repo[1]}/HEAD/package.json`, {
							signal: AbortSignal.timeout(8000),
							headers: { "user-agent": "dsh-plugin-manager" }
						});
						if (response.ok) githubManifest = await response.json();
					} catch { /* 清单不可读 -> 装后校验兜底 */ }
					const realName = githubManifest?.name;
					if (typeof realName === "string" && realName !== "" && installedNames.has(realName)) {
						return { status: "already-installed", packageName: realName, url, method, message: `${realName} 已安装。` };
					}
					if (githubManifest !== null && githubManifest?.dsh?.bundle?.patch === void 0 && githubManifest?.dsh?.client === void 0) {
						return { status: "failed", packageName: name, url, method: null, message: "该仓库未声明 dsh 清单（dsh.bundle / dsh.client），无法作为插件安装。" };
					}
				}
				// 3) 解析安装来源
				const installUrl = npm !== null ? `https://registry.npmjs.org/${npm}` : url;
				if (dryRun === true) {
					return { status: "dry-run", packageName, url: installUrl, method, message: `将安装 ${packageName}（${method === "npm" ? "npm registry" : "GitHub"}）。` };
				}
				// 4) 安装（npm 直装 / GitHub 下载后 file: 安装），带 pnpm 恢复
				const pnpmArgs = npm !== null ? ["add", npm] : null;
				if (pnpmArgs === null) {
					const [owner, repoName] = repo[1].split("/");
					let downloadUrl = null;
					try {
						const release = await fetchGitHubRelease(repo[1]);
						if (release !== null) {
							const tgz = (release.assets ?? []).find((a) => /\.(tgz|tar\.gz)$/i.test(a.name ?? ""));
							if (tgz?.browser_download_url) downloadUrl = tgz.browser_download_url;
						}
						if (downloadUrl === null) downloadUrl = `https://codeload.github.com/${owner}/${repoName}/tar.gz/refs/heads/main`;
					} catch {
						downloadUrl = `https://codeload.github.com/${owner}/${repoName}/tar.gz/refs/heads/main`;
					}
					this.log("marketInstall", `${packageName} downloading ${downloadUrl.slice(0, 120)}`);
					const dl = await downloadPluginUrl(downloadUrl, (line) => this.log("market-download", line));
					if (dl.status !== "downloaded" || dl.file === null) {
						return { status: "failed", packageName, url: installUrl, method, message: dl.message ?? "下载失败" };
					}
					try {
						const result = await this.runPnpmWithRecovery(["add", dl.file]);
						if (result.status !== 0) return { status: "failed", packageName, url: installUrl, method, message: result.error ?? "安装失败" };
					} finally {
						cleanupDownload(dl.file);
					}
				} else {
					const result = await this.runPnpmWithRecovery(pnpmArgs);
					if (result.status !== 0) return { status: "failed", packageName, url: installUrl, method, message: result.error ?? "安装失败" };
				}
				// 5) 装后防砖校验：必须声明 dsh 清单（bundle 或 client），否则自动卸载
				this.profileDeps = readProfileDeps(this.location);
				PACKAGE_CACHE.clear();
				const realInstalledName = githubManifest?.name ?? packageName;
				const root = join(this.location.directory, "node_modules", realInstalledName);
				let dshManifest = null;
				try {
					dshManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.dsh ?? null;
				} catch { /* 未找到包目录 */ }
				if (dshManifest === null || (dshManifest?.bundle === void 0 && dshManifest?.client === void 0)) {
					const remove = await spawnPnpm(["remove", realInstalledName], this.location.directory);
					this.profileDeps = readProfileDeps(this.location);
					this.log("marketInstall", `${realInstalledName}: no dsh manifest after install — auto-removed (${remove.status})`);
					return { status: "failed", packageName: realInstalledName, url: installUrl, method, message: "安装成功但该包未声明 dsh 清单（缺少 dsh.bundle/dsh.client），已自动卸载，避免下次启动失败。" };
				}
				this.log("marketInstall", `installed ${realInstalledName} via ${method}`);
				return { status: "installed", packageName: realInstalledName, url: installUrl, method, message: `${realInstalledName} 已安装，重启 profile 后生效。` };
			});
		}
		/** pnpm 安装带已知陷阱恢复：hoist 漂移 -> 重建 modules 重试一次；minimumReleaseAge -> 跳过重试一次。 */
		async runPnpmWithRecovery(args) {
			let result = await spawnPnpm(args, this.location.directory);
			if (result.status === 0) return result;
			const output = `${result.error ?? ""}`;
			if (/hoist[- ]pattern[- ]diff/i.test(output)) {
				this.log("marketInstall", "pnpm modules dir drifted — rebuilding once and retrying");
				await spawnPnpm(["install", "--no-frozen-lockfile"], this.location.directory);
				result = await spawnPnpm(args, this.location.directory);
				if (result.status === 0) return result;
			}
			if (/minimumReleaseAge|too young|ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL/i.test(output)) {
				this.log("marketInstall", "fresh release age gate — retrying once with minimumReleaseAge=0");
				result = await spawnPnpm(["--config.minimumReleaseAge=0", ...args], this.location.directory);
			}
			return result;
		}
		//#endregion
		async updateOne(packageName) {
			const spec = this.profileDeps[packageName];
			if (spec === void 0) {
				return {
					packageName,
					status: "not-managed",
					message: "不是本 profile 的依赖（随 dsh 安装提供），请通过更新 dsh 安装本体获取新版本。",
					installedVersion: packageInfoOf(packageName, this.baseUrl).installedVersion,
					latestVersion: null
				};
			}
			if (/^(file:|link:|workspace:)/.test(spec)) {
				return {
					packageName,
					status: "not-managed",
					message: "本地包（file:/link:），请用 dsh plugin --profile <name> add <新包> 更新。",
					installedVersion: packageInfoOf(packageName, this.baseUrl).installedVersion,
					latestVersion: null
				};
			}
			const installed = packageInfoOf(packageName, this.baseUrl).installedVersion;
			let best = LATEST_CACHE.get(packageName);
			if (best === void 0 || best.version === null) {
				best = await refreshLatest(packageName, this.sources);
			}
			if (best.version === null) {
				return {
					packageName,
					status: "not-managed",
					message: "无法从启用的更新源获取该包版本（离线或源不可达）。",
					installedVersion: installed,
					latestVersion: null
				};
			}
			if (installed !== null && compareVersions(best.version, installed) <= 0) {
				return {
					packageName,
					status: "up-to-date",
					message: null,
					installedVersion: installed,
					latestVersion: best.version
				};
			}
			const source = this.sources.find((s) => s.enabled && s.name === best.sourceName) ?? this.sources.find((s) => s.enabled);
			if (source === void 0) {
				return {
					packageName,
					status: "not-managed",
					message: "没有启用的更新源。",
					installedVersion: installed,
					latestVersion: best.version
				};
			}
			// github / dshfind 源：解析下载链接 -> 通用下载器（HTTP 直链 / magnet / torrent，支持 P2P）
			if (source.type === "github" || source.type === "dshfind") {
				const downloadUrl = await resolveSourceDownloadUrl(source, best);
				if (downloadUrl === null) {
					return {
						packageName,
						status: "not-managed",
						message: "无法解析该源的下载链接。",
						installedVersion: installed,
						latestVersion: best.version
					};
				}
				this.log("update", `${packageName}: downloading via ${source.type} from ${downloadUrl.slice(0, 120)}`);
				const dl = await downloadPluginUrl(downloadUrl, (line) => this.log("download", line));
				if (dl.status !== "downloaded" || dl.file === null) {
					return {
						packageName,
						status: "failed",
						message: dl.message ?? "下载失败",
						installedVersion: installed,
						latestVersion: best.version
					};
				}
				const result = await spawnPnpm(["add", dl.file], this.location.directory);
				cleanupDownload(dl.file);
				if (result.status !== 0) {
					return {
						packageName,
						status: "failed",
						message: result.error ?? "pnpm 更新失败",
						installedVersion: installed,
						latestVersion: best.version
					};
				}
			} else {
				const pnpmArgs = [`add`, `${packageName}@${best.version}`, "--registry", source.url];
				const result = await spawnPnpm(pnpmArgs, this.location.directory);
				if (result.status !== 0) {
					return {
						packageName,
						status: "failed",
						message: result.error ?? "pnpm 更新失败",
						installedVersion: installed,
						latestVersion: best.version
					};
				}
			}
			// 更新成功：清缓存并重读已装版本
			PACKAGE_CACHE.delete(`${this.baseUrl}\0${packageName}`);
			VERSION_CACHE.clear();
			LATEST_CACHE.set(packageName, { ...best, at: Date.now() });
			const newInstalled = packageInfoOf(packageName, this.baseUrl).installedVersion;
			return {
				packageName,
				status: "updated",
				message: "已更新到 " + (newInstalled ?? best.version) + "，重启 profile 后生效。",
				installedVersion: newInstalled,
				latestVersion: best.version
			};
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
				entries,
				sources: this.sources.map((s) => ({ ...s }))
			};
		}
		project(entry) {
			const self = entry.options.name === SELF_MODULE;
			const archived = ARCHIVED_IDS.has(entry.options.id);
			const protectedById = this.protectedIds.has(entry.options.id);
			const protectsManager = this.isManagerAncestor(entry);
			const protectionReason = self ? "插件管理器不能停用自身。" : protectsManager ? "该条目承载插件管理器的生命周期。" : archived ? "架构保留：由浏览器端/其它层提供，启用会破坏架构并导致界面崩坏，禁止开关。" : UI_CRITICAL_IDS.has(entry.options.id) ? "界面必需插件：停用会导致界面崩坏，禁止开关。" : protectedById ? "该条目是 Web 管理界面/会话恢复所必需的。" : null;
			const fiber = entry.fiber;
			const configId = entry.options.id;
			const packageName = packageRoot(entry.options.name);
			const info = packageInfoOf(entry.options.name, this.baseUrl);
			const installed = info.installedVersion;
			const latestEntry = LATEST_CACHE.get(packageName);
			const latest = latestEntry?.version ?? null;
			const spec = this.profileDeps[packageName];
			const managed = spec !== void 0 && !/^(file:|link:|workspace:)/.test(spec);
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
				archived,
				installedVersion: installed,
				latestVersion: latest,
				updateSource: latestEntry?.sourceName ?? null,
				needsUpdate,
				managed
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
		/** 操作日志（进入 host 的 web 日志，便于排查）。 */
		log(action, detail) {
			try {
				this.ctx.logger?.info(`[plugin-manager] ${action}${detail !== void 0 ? `: ${detail}` : ""}`);
			} catch {
				// 日志失败不影响操作
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
