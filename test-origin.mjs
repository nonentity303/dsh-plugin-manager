// test-origin.mjs — v1.1.0 M2：写接口来源防护（桌面版 dsh-app://app）契约测试
// 用法: node test-origin.mjs（退出码 0=全绿，1=有断言失败）
//
// 背景（契约 F1/F2，见 docs/桌面版移植-1.1.0设计.md 第 1 节）：桌面版渲染进程的页面来源是**自定义协议**
// `dsh-app://app`（Electron 从打包静态资源加载，不是 HTTP 源）。若不给 guardWriteRequest 开"允许桌面来源"，
// 桌面版里救援球 / 维护页签 / `/plugins` 的启停/重启会被自家同源白名单全部 403（只读空壳）。
//
// 本套件断言三件事：
//  ① **web 场景零回归**：allowedOriginsOf 返回值逐字节不变；默认（不传 allowDesktopApp）判定与 1.0.x 一致。
//  ② **只放行固定来源**：显式允许后仅接受 `dsh-app://app`（含末尾 "/"、大小写变体），且**照旧校验令牌**。
//  ③ **不放松任何既有防线**：第三方 http(s) 源仍 403、`Origin: null` 默认仍 403、"没有 Origin"语义不变。
import {
	DESKTOP_APP_ORIGIN, allowedOriginsOf, guardDesktopToken, guardWriteRequest, mintDesktopToken,
	newApiToken, sameOriginOf, writeOriginPolicyFromEnv
} from "./lib/enginectl.mjs";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log("用法: node test-origin.mjs（v1.1.0 M2 写接口来源防护契约测试；无需参数、不联网、不写盘）");
	process.exit(0);
}

const failures = [];
let checks = 0;

/** 逐条断言：通过打印 OK，失败累计到 failures 并打印原因。 */
const ok = (name, cond, detail = "") => {
	checks++;
	if (cond) { console.log(`OK: ${name}`); return; }
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
	console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
};

const PORT = 3081;
const tokenA = newApiToken();
const tokenB = newApiToken();
const desktopToken = mintDesktopToken();
const headers = (origin, extra = {}) => {
	const out = { ...extra };
	if (origin !== void 0) out.origin = origin;
	return { headers: out };
};
/**
 * 跑一次 guardWriteRequest：默认带**正确的页面令牌**（tokenA）。
 * `sendToken` 覆盖实际发出的令牌（测试错误/缺失/桌面令牌）；其余选项透传给 guardWriteRequest。
 */
const guard = (origin, opts = {}) => {
	const { sendToken = tokenA, ...rest } = opts;
	return guardWriteRequest(headers(origin, { "x-dsh-pm-token": sendToken }), { port: PORT, token: tokenA, ...rest });
};
const statusOf = (result) => (result === null ? 0 : result.status);

// ---------------------------------------------------------------- 0. 令牌与策略原语
console.log("== 0. 令牌 / 环境策略原语 ==");
ok("mintDesktopToken(): 48 hex（与 newApiToken 同格式）", /^[0-9a-f]{48}$/.test(desktopToken));
ok("mintDesktopToken(): 每次调用都随机（两次不同）", mintDesktopToken() !== mintDesktopToken());
ok("newApiToken() 仍为 48 hex（既有 API 未变）", /^[0-9a-f]{48}$/.test(tokenA) && /^[0-9a-f]{48}$/.test(tokenB));
ok("guardDesktopToken: 缺少 X-DSH-PM-Token → 401", guardDesktopToken({ headers: {} }, desktopToken)?.status === 401);
ok("guardDesktopToken: 错误令牌 → 401", guardDesktopToken({ headers: { "x-dsh-pm-token": tokenB } }, desktopToken)?.status === 401);
ok("guardDesktopToken: 正确令牌 → 通过（null）", guardDesktopToken({ headers: { "x-dsh-pm-token": desktopToken } }, desktopToken) === null);

const envDefault = writeOriginPolicyFromEnv({});
ok("writeOriginPolicyFromEnv: 默认全关（web 场景零回归）",
	envDefault.allowDesktopApp === false && envDefault.allowNullOrigin === false && envDefault.desktopToken === null,
	JSON.stringify(envDefault));
const envDesktopOnly = writeOriginPolicyFromEnv({ DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN: "1" });
ok("writeOriginPolicyFromEnv: 只开桌面来源时 null 来源仍关",
	envDesktopOnly.allowDesktopApp === true && envDesktopOnly.allowNullOrigin === false);
const envAll = writeOriginPolicyFromEnv({
	DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN: "1", DSH_DRYDOCK_ALLOW_NULL_ORIGIN: "1", DSH_DRYDOCK_DESKTOP_TOKEN: desktopToken
});
ok("writeOriginPolicyFromEnv: 三项全读（含令牌，令牌不进日志由调用方负责）",
	envAll.allowDesktopApp === true && envAll.allowNullOrigin === true && envAll.desktopToken === desktopToken);
ok("writeOriginPolicyFromEnv: 只写 ALLOW_NULL 但不开桌面来源 → null 来源仍关（不允许跳过第一级）",
	writeOriginPolicyFromEnv({ DSH_DRYDOCK_ALLOW_NULL_ORIGIN: "1" }).allowNullOrigin === false);
ok("writeOriginPolicyFromEnv: 只认字符串 \"1\"（\"true\" 不算显式开启）",
	writeOriginPolicyFromEnv({ DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN: "true" }).allowDesktopApp === false);

// ---------------------------------------------------------------- 1. 零回归：allowedOriginsOf 逐字节不变
console.log("== 1. web 零回归（硬断言） ==");
const LEGACY_ORIGINS = ["http://127.0.0.1:3081", "http://localhost:3081", "http://[::1]:3081"];
const legacyActual = allowedOriginsOf(PORT);
ok("allowedOriginsOf(3081) 严格等于三元素回环白名单（同序同值，逐字节）",
	JSON.stringify(legacyActual) === JSON.stringify(LEGACY_ORIGINS),
	`actual=${JSON.stringify(legacyActual)}`);
ok("allowedOriginsOf(3081) 与旧实现字面量完全一致（JSON 逐字节 = 锁死顺序）",
	JSON.stringify(legacyActual) === '["http://127.0.0.1:3081","http://localhost:3081","http://[::1]:3081"]',
	JSON.stringify(legacyActual));
ok("sameOriginOf(3081) 仍是白名单第一项（旧 API 不变）", sameOriginOf(PORT) === LEGACY_ORIGINS[0]);
ok("allowedOriginsOf(3081,{allowDesktopApp:false}) 与不传选项完全一致",
	JSON.stringify(allowedOriginsOf(PORT, { allowDesktopApp: false })) === JSON.stringify(LEGACY_ORIGINS));
const desktopList = allowedOriginsOf(PORT, { allowDesktopApp: true });
ok("allowedOriginsOf(3081,{allowDesktopApp:true}) = 旧三项（同序）+ dsh-app://app",
	desktopList.length === 4 && JSON.stringify(desktopList.slice(0, 3)) === JSON.stringify(LEGACY_ORIGINS)
	&& desktopList[3] === DESKTOP_APP_ORIGIN,
	JSON.stringify(desktopList));
ok("白名单里没有任何第三方 http(s) 源（0.0.0.0 / 局域网 / 前缀伪装）",
	!desktopList.some((o) => /0\.0\.0\.0|localhost\.|192\.168\.|10\./.test(o) || /^https?:\/\/(?!127\.0\.0\.1:|localhost:|\[::1\]\:)/.test(o)),
	JSON.stringify(desktopList));

// ---------------------------------------------------------------- 2. 默认（不传 allowDesktopApp）：桌面来源被拒
console.log("== 2. 默认关：桌面来源仍被拒（P0 修复的默认态） ==");
{
	const withToken = guard("dsh-app://app", { desktopToken });
	ok("默认 + Origin dsh-app://app + 正确页面令牌 → 403", statusOf(withToken) === 403, JSON.stringify(withToken));
	ok("默认 + Origin dsh-app://app 的 403 消息说明\"疑似桌面来源但未允许\"",
		/疑似桌面版来源/.test(withToken?.message ?? ""), withToken?.message);
	ok("默认 + Origin dsh-app://app 且不带令牌 → 403（Origin 闸门先于令牌检查）",
		statusOf(guard("dsh-app://app", { sendToken: null })) === 403);
	ok("默认 + 即使配了 desktopToken，Origin dsh-app://app 仍 403（来源开关才是总闸）",
		statusOf(guard("dsh-app://app", { allowDesktopApp: false, desktopToken })) === 403);
}

// ---------------------------------------------------------------- 3. allowDesktopApp：桌面来源放行 + 令牌照旧
console.log("== 3. allowDesktopApp：放行固定来源，但令牌不许跳过 ==");
const desktopOn = { allowDesktopApp: true, desktopToken };
ok("allowDesktopApp + 桌面令牌 + Origin dsh-app://app → 通过（null）",
	guard("dsh-app://app", { ...desktopOn, sendToken: desktopToken }) === null,
	JSON.stringify(guard("dsh-app://app", { ...desktopOn, sendToken: desktopToken })));
ok("allowDesktopApp + 页面令牌 + Origin dsh-app://app → 通过（服务自身令牌仍是合法凭据）",
	guard("dsh-app://app", { allowDesktopApp: true }) === null);
{
	const got = guardWriteRequest(headers("dsh-app://app", { "x-dsh-pm-token": tokenB }), { port: PORT, token: tokenA, ...desktopOn });
	ok("allowDesktopApp + 错误令牌 → 401（来源放行 ≠ 免令牌）", statusOf(got) === 401, JSON.stringify(got));
	ok("allowDesktopApp + 错误令牌的 401 不回显令牌值（令牌纪律）",
		!String(got?.message ?? "").includes(tokenB) && !String(got?.message ?? "").includes(tokenA));
	ok("allowDesktopApp + 缺少令牌 → 401",
		statusOf(guard("dsh-app://app", { ...desktopOn, sendToken: null })) === 401);
}
for (const variant of ["dsh-app://app/", "Dsh-App://App", "DSH-APP://APP", "Dsh-App://App/"]) {
	ok(`allowDesktopApp + 大小写/末尾斜杠变体 ${variant} → 通过（规范化）`,
		guard(variant, desktopOn) === null);
}
for (const variant of ["Dsh-App://App", "dsh-app://app/"]) {
	ok(`默认（不传 allowDesktopApp）+ 变体 ${variant} 仍 → 403`,
		statusOf(guard(variant, { desktopToken })) === 403);
}

// ---------------------------------------------------------------- 4. 不许顺带放松第三方源
console.log("== 4. 第三方 http(s) 源：开了桌面来源也照样 403 ==");
ok("allowDesktopApp + Origin https://evil.example + 正确令牌 → 仍 403",
	statusOf(guard("https://evil.example", desktopOn)) === 403);
ok("allowDesktopApp + Origin http://localhost:3082（端口不对）→ 仍 403",
	statusOf(guard("http://localhost:3082", desktopOn)) === 403);
ok("allowDesktopApp + Origin http://localhost.evil.example:3081（前缀伪装）→ 仍 403",
	statusOf(guard("http://localhost.evil.example:3081", desktopOn)) === 403);
ok("allowDesktopApp + Origin http://0.0.0.0:3081（非本机等价源）→ 仍 403",
	statusOf(guard("http://0.0.0.0:3081", desktopOn)) === 403);
ok("默认 + Origin http://evil.example（无令牌）→ 403（Origin 闸门先于令牌检查，既有顺序不变）",
	statusOf(guard("http://evil.example", { sendToken: null })) === 403);
for (const other of ["dsh-app://shell", "dsh-app://app:3081", "dsh-app://app@evil.example", "dsh-app://evil"]) {
	ok(`allowDesktopApp + 其他 dsh-app 页面 ${other} → 403（只认固定 host）`,
		statusOf(guard(other, desktopOn)) === 403);
}

// ---------------------------------------------------------------- 5. 同机同端口：既有行为不变
console.log("== 5. 同机同端口（web 既有行为） ==");
for (const origin of LEGACY_ORIGINS) {
	ok(`同机同端口 ${origin} + 正确令牌 → 通过（web 与桌面模式下都成立）`,
		guard(origin) === null && guard(origin, desktopOn) === null);
	ok(`同机同端口 ${origin} + 错误令牌 → 401`, statusOf(guardWriteRequest(headers(origin, { "x-dsh-pm-token": tokenB }), { port: PORT, token: tokenA })) === 401);
}
ok("同机同端口但端口不对 http://localhost:3082 → 403", statusOf(guard("http://localhost:3082")) === 403);
ok("同机同端口但端口不对 http://127.0.0.1:3082 → 403", statusOf(guard("http://127.0.0.1:3082")) === 403);

// ---------------------------------------------------------------- 6. 空 Origin（非浏览器本地工具）语义不变
console.log("== 6. 空 Origin：与 1.0.x 一致 ==");
ok("空 Origin + 正确令牌 → 通过（本地工具调用，既有语义）",
	guard(void 0) === null);
ok("空 Origin + 正确令牌 + allowDesktopApp → 仍通过",
	guard(void 0, desktopOn) === null);
ok("空 Origin + 缺少令牌 → 401（没有 Origin 不等于免令牌）",
	statusOf(guard(void 0, { ...desktopOn, sendToken: null })) === 401);
ok("空 Origin + 错误令牌 → 401（没有 Origin 不等于免令牌）",
	statusOf(guardWriteRequest(headers(void 0, { "x-dsh-pm-token": tokenB }), { port: PORT, token: tokenA })) === 401);

// ---------------------------------------------------------------- 7. Origin: null（不透明来源）默认仍拒
console.log("== 7. Origin: null：默认仍 403，显式两级开关且只认桌面令牌 ==");
ok("默认 + Origin: null → 403（既有防线不变）", statusOf(guard("null", { desktopToken })) === 403);
ok("allowDesktopApp 但未开 allowNullOrigin + Origin: null → 403",
	statusOf(guard("null", { allowDesktopApp: true, desktopToken })) === 403);
ok("两级开关全开 + Origin: null 但只带页面令牌 → 401（不透明来源只认桌面令牌）",
	statusOf(guard("null", { allowDesktopApp: true, allowNullOrigin: true, desktopToken })) === 401);
ok("两级开关全开 + Origin: null + 桌面令牌 → 通过",
	guardWriteRequest(headers("null", { "x-dsh-pm-token": desktopToken }), {
		port: PORT, token: tokenA, allowDesktopApp: true, allowNullOrigin: true, desktopToken
	}) === null);
ok("两级开关全开但没配 desktopToken + Origin: null → 401（没有密钥就没有放行依据）",
	statusOf(guardWriteRequest(headers("null", { "x-dsh-pm-token": tokenA }), {
		port: PORT, token: tokenA, allowDesktopApp: true, allowNullOrigin: true
	})) === 401);

// ---------------------------------------------------------------- 收尾
console.log("");
if (failures.length > 0) {
	console.error(`RESULT: FAIL - ${failures.length}/${checks} 条断言失败`);
	for (const item of failures) console.error(`  - ${item}`);
	process.exit(1);
}
console.log(`RESULT: PASS - 写接口来源防护契约（${checks} 条断言：allowedOriginsOf 零回归 / 桌面 dsh-app://app 放行 / 令牌照旧 / 第三方源与 Origin: null 不放松）`);
process.exit(0);
