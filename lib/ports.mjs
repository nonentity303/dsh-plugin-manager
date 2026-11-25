/**
 * ports.mjs — 端口推导的唯一事实来源（启动器 / 救援守护 / 引擎共享）。
 *
 * 背景（"端口补完"任务）：默认端口 3080/3081/3082/4081 曾散落在 bin/ 与 lib/ 多处，
 * 用户改端口（特殊需求 / 端口冲突）时链路各处各说各话。这里集中定义：
 *   - 三个默认端口常量；
 *   - 环境变量解析（DSH_ENGINE_PORT / DSH_LAUNCHER_PORT / DSH_RESCUE_PORT）；
 *   - 守护单实例锁端口推导（启动器端口 + 1000）；
 *   - 回环入口 URL 构造。
 *
 * 本模块**零依赖、纯函数**（不做 IO、不读 process 之外的全局），可被 bin/ 与 lib/ 任意引用。
 * 注意：浏览器 bundle（src/client.jsx）不直接依赖本模块 —— 引擎侧通过
 * lib/index.js 的 `/plugins-launcher` 路由把运行时真实端口告诉前端。
 */

export const DEFAULT_ENGINE_PORT = 3080;
export const DEFAULT_LAUNCHER_PORT = 3081;
export const DEFAULT_RESCUE_PORT = 3082;

/** 启动器写进 `.open-boot.pid` 的身份标记（与 lib/enginectl.mjs 的 LAUNCHER_APP 同值）。 */
export const LAUNCHER_PID_APP = "dsh-open-boot";

/** 守护单实例锁相对启动器端口的偏移（3081 → 4081）。 */
export const LOCK_PORT_OFFSET = 1000;

/** 合法端口上限（含）。 */
export const MAX_PORT = 65535;

/**
 * 归一化端口值：只接受 1..65535 的整数 / 纯数字字符串；其它一律返回 null。
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizePort(value) {
	if (typeof value === "number") {
		return Number.isInteger(value) && value > 0 && value <= MAX_PORT ? value : null;
	}
	if (typeof value === "string") {
		const text = value.trim();
		if (!/^\d+$/.test(text)) return null;
		const n = Number(text);
		return Number.isInteger(n) && n > 0 && n <= MAX_PORT ? n : null;
	}
	return null;
}

/** 从环境变量取端口：非法/缺省 → fallback（fallback 也非法时返回 null）。 */
export function portFromEnv(value, fallback) {
	const n = normalizePort(value);
	return n === null ? normalizePort(fallback) : n;
}

/** 引擎端口：DSH_ENGINE_PORT（默认 3080）。 */
export function enginePortFromEnv(env = process.env) {
	return portFromEnv(env.DSH_ENGINE_PORT, DEFAULT_ENGINE_PORT) ?? DEFAULT_ENGINE_PORT;
}

/** 启动器端口：DSH_LAUNCHER_PORT（默认 3081）。 */
export function launcherPortFromEnv(env = process.env) {
	return portFromEnv(env.DSH_LAUNCHER_PORT, DEFAULT_LAUNCHER_PORT) ?? DEFAULT_LAUNCHER_PORT;
}

/** 救援守护端口：DSH_RESCUE_PORT（默认 3082）。 */
export function rescuePortFromEnv(env = process.env) {
	return portFromEnv(env.DSH_RESCUE_PORT, DEFAULT_RESCUE_PORT) ?? DEFAULT_RESCUE_PORT;
}

/**
 * 守护单实例锁端口 = 启动器端口 + 1000。
 * 越界（启动器端口 > 64535）返回 null —— 调用方必须显式报错，不能拿一个非法端口去 listen/探测。
 * @param {unknown} launcherPort
 * @returns {number|null}
 */
export function lockPortOf(launcherPort) {
	const port = normalizePort(launcherPort);
	if (port === null || port + LOCK_PORT_OFFSET > MAX_PORT) return null;
	return port + LOCK_PORT_OFFSET;
}

/**
 * 回环入口 URL（浏览器主页 / 桌面快捷方式 / 页面提示统一使用）。
 * @param {unknown} port
 * @param {string} [host] 默认 127.0.0.1（与监听地址一致）
 * @returns {string|null}
 */
export function entryUrlOf(port, host = "127.0.0.1") {
	const n = normalizePort(port);
	return n === null ? null : `http://${host}:${n}/`;
}

/**
 * 解析"启动器入口"（客户端「mod 体检」跳转用）：优先级
 *   ① 本 profile 的 `.open-boot.pid` 里记录的端口（app 必须是 dsh-open-boot，避免读到别人的/坏 JSON）；
 *   ② 环境变量 DSH_LAUNCHER_PORT；
 *   ③ 默认 3081。
 * 纯函数（不做 IO），便于 `--ensure/--supervise` 之外的前台启动与单测共用同一套推导。
 * @param {{pidInfo?: object|null, env?: Record<string,string|undefined>, fallback?: number}} [opts]
 * @returns {{port:number, url:string}}
 */
export function launcherUrlFrom({ pidInfo = null, env = process.env, fallback = DEFAULT_LAUNCHER_PORT } = {}) {
	let port = null;
	if (pidInfo && typeof pidInfo === "object" && pidInfo.app === LAUNCHER_PID_APP) {
		port = normalizePort(pidInfo.port);
	}
	if (port === null) port = normalizePort(env?.DSH_LAUNCHER_PORT);
	if (port === null) port = normalizePort(fallback) ?? DEFAULT_LAUNCHER_PORT;
	return { port, url: entryUrlOf(port) };
}
