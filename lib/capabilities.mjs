/**
 * capabilities.mjs — 形态能力门控表（1.1.0 桌面版移植的**唯一**开关事实来源）。
 *
 * 设计契约：docs/桌面版移植-1.1.0设计.md 第 2 节。规矩只有三条：
 *   1. 一处探测（lib/envprobe.mjs）→ 一张表（本文件）→ UI 按表渲染；**不许散落 `if (isDesktop)`**；
 *   2. 被关掉/受限的每一项都要能点开看**一句话中文理由**（"灰着但告诉你为什么"），不许"能点但失败"；
 *   3. 未识别形态 → **退回 web 表**，这是"网页版零回归"最硬的保证。
 *
 * 本模块纯数据 + 纯函数，零 IO、零依赖。
 */

/** 已知形态（新增形态必须同时补表 + 补理由，否则 capabilityReason 会明确指名缺登记）。 */
export const CAPABILITY_KINDS = Object.freeze(["web", "desktop"]);

/**
 * 能力键 → 中文理由。web/desktop 两张表必须**键集合一致**（test-capabilities.mjs 会断言），
 * 否则 UI 按另一张表的键渲染时会出现"灰着但没理由"的空洞。
 */
const WEB_REASONS = Object.freeze({
	takeoverOfficialPage:
		"网页版 profile 由 drydock 全权负责：停用内置 @deepseek-ai/dsh-client-ui-plugin-manager 后由本插件接管插件页，官方对网页版不设保护门槛。",
	livePnpmOps:
		"网页版引擎由 drydock 自己拉起，可直接执行 pnpm 增删并等 engineHealth 收敛，无需先退出别的进程。",
	hotToggle:
		"网页版可直接改写 cordis.patch.yml 的 drydock 归属行并重启引擎生效（引擎只在启动时套用），改动可逆且会先备份。",
	autostart:
		"网页版可用 HKCU Run + wscript→node 注册开机自启，并可一键撤销，不存在与官方托盘抢启动的冲突。",
	browserLauncher:
		"网页版由 open-boot 常驻 3081 提供「打开浏览器即自检并拉起引擎」的入口，主页设成它即可用。",
	market:
		"网页版可展示 dshfind 精选目录并就地安装/卸载，不依赖官方 bundle。",
	scenarios:
		"网页版允许读写类救援场景：改写 profile 配置、修复 patch、必要时隔离坏条目。",
	rescueDaemon:
		"网页版常驻 3082 独立救援守护，引擎挂掉时仍能提供兜底页与修复入口。",
	engineLifecycle:
		"网页版由 drydock 自己 spawn / kill / 重启引擎进程，存活用 engineHealth（HTTP 握手 + 身份指纹）判定。",
	offlineDiagnostics:
		"网页版可离线读取日志与崩溃报告并生成只读诊断报告。"
});

const DESKTOP_REASONS = Object.freeze({
	takeoverOfficialPage:
		"桌面版插件页由 Electron 独占管理（官方 PROTECTED_PLUGINS 保护 @deepseek-ai/dsh-client-ui-plugin-manager），在此接管有静默失效风险；请用桌面版自带插件页",
	livePnpmOps:
		"桌面版持单实例锁且独占自己的 node_modules/插件激活，pnpm 增删必须等 Electron 完全退出后做；持锁时一律拒绝，不做半途安装。",
	hotToggle:
		"桌面版只允许「可逆 + 已有备份 + 只改 drydock 自己归属行」的开关：官方恢复会重写 cordis.patch.yml，越界写入会在下次启动被静默丢弃。",
	autostart:
		"桌面版已有官方托盘与后台任务负责启动，drydock 再注册 HKCU 自启会造成双开与单实例锁冲突，因此拒绝并说明原因（不是静默跳过）。",
	browserLauncher:
		"桌面版页面来自 dsh-app:// 且 Host 端口随机，浏览器即启动器无从指向目标；已降级为只读诊断入口，只给日志与修复建议。",
	market:
		"桌面版插件市场由官方 bundle（dsh-experimental-plugin-market-bundle / dshmarket）负责，drydock 不重复安装以免两套目录打架。",
	scenarios:
		"桌面版只允许只读诊断与离线修复场景：不改 profile 配置、不删 product patch 行、不装包。",
	rescueDaemon:
		"独立救援守护不碰 Host 进程，桌面版仍是 drydock 的主战场：负责 Electron 之外的灾备与「官方恢复后自愈」。",
	engineLifecycle:
		"桌面版 Host 由 Electron 托管（engineLifecycle: delegated），drydock 绝不 spawn / kill，只提示「请从系统托盘完全退出后重开」。",
	offlineDiagnostics:
		"桌面版日志与崩溃报告在 userData 下（普通用户根本找不到），drydock 提供离线只读诊断报告——这是桌面版最缺的东西。"
});

/**
 * 能力表。每一项都 Object.freeze（运行时改不动），外层表也冻结。
 * 值语义：`true` 放行 / `false` 关闭 / 字符串为模式值（hotToggle 的 "gated" 之外，
 * scenarios、engineLifecycle 是两档模式，见 PERMISSIVE_MODES）。
 */
export const CAPABILITIES = Object.freeze({
	web: Object.freeze({
		id: "web",
		takeoverOfficialPage: true, // 停用内置 ui-plugin-manager 并接管
		livePnpmOps: true, // 现跑 pnpm 增删
		hotToggle: true, // 写 patch 行 + 重启引擎生效
		autostart: true, // HKCU Run + wscript→node
		browserLauncher: true, // 3081 浏览器即启动器 / open-boot
		market: true, // dshfind 精选目录
		scenarios: "read-write",
		rescueDaemon: true, // 3082 独立救援守护
		engineLifecycle: "own", // 自己 spawn / kill / 重启
		offlineDiagnostics: true
	}),
	desktop: Object.freeze({
		id: "desktop",
		takeoverOfficialPage: false, // 撞 PROTECTED_PLUGINS + app 级插件页
		livePnpmOps: false, // 需 Electron 完全退出；持锁时一律拒绝
		hotToggle: "gated", // 允许：可逆 + 有备份 + 只动自己归属行
		autostart: false, // 官方托盘 / 后台任务已覆盖
		browserLauncher: false, // 降级为诊断入口
		market: false, // 交给官方 bundle + dshmarket
		scenarios: "read-only",
		rescueDaemon: true, // ← 桌面版唯一主战场
		engineLifecycle: "delegated", // 绝不 spawn/kill Host，只提示"从托盘完全退出"
		offlineDiagnostics: true
	})
});

/** 模式值里"放行"的那一档；落在其它档 = 该能力受限。 */
const PERMISSIVE_MODES = Object.freeze({
	scenarios: "read-write",
	engineLifecycle: "own"
});

function hasKey(table, key) {
	return Object.prototype.hasOwnProperty.call(table, key);
}

function reasonsOf(table) {
	return table.id === "desktop" ? DESKTOP_REASONS : WEB_REASONS;
}

/**
 * 取形态能力表。**未识别形态（undefined / null / 拼错）一律退回 web 表**——
 * 网页版零回归的关键断言，test-capabilities.mjs 用引用相等来钉住它。
 * @param {unknown} kind
 * @returns {typeof CAPABILITIES.web}
 */
export function capabilitiesFor(kind) {
	return typeof kind === "string" && hasKey(CAPABILITIES, kind) ? CAPABILITIES[kind] : CAPABILITIES.web;
}

/**
 * 能力理由（一句话，中文，UI 灰置时直接展示）。
 * 对放行项同样返回理由，便于提示"为什么这里能点"；未知键/未登记理由绝不返回空串。
 * @param {unknown} kind
 * @param {unknown} key
 * @returns {string}
 */
export function capabilityReason(kind, key) {
	const table = capabilitiesFor(kind);
	const fallbackPrefix =
		typeof kind === "string" && hasKey(CAPABILITIES, kind) ? "" : `未识别形态（${String(kind)}）已按网页版处理：`;
	if (typeof key !== "string" || key.trim() === "") {
		return `${fallbackPrefix}能力键非法（${String(key)}）：请传 ${table.id} 能力表里的键名，否则门控会静默放空。`;
	}
	if (key === "id") {
		return `${fallbackPrefix}${table.id} 是形态标识，不是能力开关；门控请判断具体能力键。`;
	}
	if (!hasKey(table, key)) {
		return `${fallbackPrefix}未知能力键 ${key}：不在 ${table.id} 能力表中（调用方拼写错误时门控会静默放空，请修正）。`;
	}
	const text = reasonsOf(table)[key];
	if (typeof text === "string" && text.trim() !== "") return fallbackPrefix + text;
	return `${fallbackPrefix}${table.id} 未为能力 ${key} 登记理由 —— 这是缺陷：请补 lib/capabilities.mjs 的理由表。`;
}

/**
 * 统一门控断言（供调用方在动手前拦截；不许静默失败）。
 *
 * 返回：
 *   - 放行：`{ok:true, code:"capability-enabled", kind, key, value}`
 *   - 拒绝：`{ok:false, code:"capability-disabled", message:中文理由, gate:"disabled"|"gated"|"mode", ...}`
 *     （`gate` 区分"彻底关掉"与"需要额外闸门"，供 UI 分别渲染；hotToggle 的 "gated" 是后者）
 *   - 键不存在：`{ok:false, code:"capability-unknown", message}` —— 键错了必须报，不能当放行。
 * @param {unknown} kind
 * @param {unknown} key
 * @returns {{ok: boolean, code: string, kind: string, key?: string, value?: unknown, gate?: string, mode?: string, message?: string}}
 */
export function assertCapability(kind, key) {
	const table = capabilitiesFor(kind);
	const fallbackPrefix =
		typeof kind === "string" && hasKey(CAPABILITIES, kind) ? "" : `未识别形态（${String(kind)}）已按网页版处理：`;
	if (typeof key !== "string" || key.trim() === "") {
		return {
			ok: false,
			code: "capability-unknown",
			kind: table.id,
			key: String(key),
			message: `${fallbackPrefix}能力键非法（${String(key)}）：无法判断是否放行（请传能力表中的键名）。`
		};
	}
	if (key === "id") {
		return { ok: true, code: "capability-enabled", kind: table.id, key, value: table.id, message: `${fallbackPrefix}${table.id} 是形态标识，不是能力开关。` };
	}
	if (!hasKey(table, key)) {
		return {
			ok: false,
			code: "capability-unknown",
			kind: table.id,
			key,
			message: `${fallbackPrefix}未知能力键 ${key}：不在 ${table.id} 能力表中（拼写错误不能当放行）。`
		};
	}
	const value = table[key];
	if (value === true) {
		return { ok: true, code: "capability-enabled", kind: table.id, key, value, message: fallbackPrefix + reasonsOf(table)[key] };
	}
	const disabled = (gate, extra = {}) => ({
		ok: false,
		code: "capability-disabled",
		kind: table.id,
		key,
		value,
		gate,
		...extra,
		message: fallbackPrefix + reasonsOf(table)[key]
	});
	if (value === false) return disabled("disabled");
	if (value === "gated") return disabled("gated");
	if (typeof value === "string") {
		if (PERMISSIVE_MODES[key] === value) {
			return { ok: true, code: "capability-enabled", kind: table.id, key, value, mode: value, message: fallbackPrefix + reasonsOf(table)[key] };
		}
		return disabled("mode", { mode: value });
	}
	return {
		ok: false,
		code: "capability-unrecognized-value",
		kind: table.id,
		key,
		value,
		message: `${fallbackPrefix}能力 ${key} 的值 ${JSON.stringify(value)} 不是 true/false/模式字符串 —— 这是缺陷：请修 lib/capabilities.mjs。`
	};
}
