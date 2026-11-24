// 把已安装副本（0.9.1 + 运行时补丁）里的启动器补丁移植进 v0.9.1 源码。
// 断言式替换：每处必须恰好命中一次，否则不写盘退出。UTF-8 安全（Node 读写字节流）。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = join(process.cwd(), "bin", "open-boot.mjs");
let src = readFileSync(FILE, "utf8");
if (src.includes("latestTokenUrl")) { console.log("已有补丁，跳过"); process.exit(0); }

const Q = (s) => s; // 标记：以下字符串全部为源码原样文本
const edits = [];

// ① latestTokenUrl（含 303 适配；正则用 ENGINE_PORT 动态构造）
edits.push([
Q('const engineLogPathOf = (args) => join(args.profile, "rescue-daemon.log");'),
Q(`const engineLogPathOf = (args) => join(args.profile, "rescue-daemon.log");
/**
 * 2026-11-24 启动器补丁（自 v0.9.1 运行时补丁移植）：给启动页一个**可直接用的**入口 URL。
 * 引擎每次进程重启都会换新的 launchToken（每进程随机，只打印在自己的 stdout 上），而 web.log
 * 可能是上一个进程写的 → 拿旧 token 去跳只会撞 401。所以必须先验证：0.2.x 有效 token 返回
 * 303（浏览器带 cookie 落地）；无效/陈旧 token 是 401。两者都不是就不给 URL，页面退回旧行为。
 */
async function latestTokenUrl() {
	try {
		const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
		const text = readFileSync(join(home, "logs", "web.log"), "utf8");
		const tokenRe = new RegExp("http:\\\\/\\\\/127\\\\.0\\\\.0\\\\.1:" + ENGINE_PORT + "\\\\/\\\\?token=[A-Za-z0-9_\\\\-.]+", "g");
		const all = [...text.matchAll(tokenRe)].map((m) => m[0]);
		if (!all.length) return null;
		const url = all[all.length - 1];
		const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2500) });
		const body = await res.text();
		return res.status === 303 || (res.status === 200 && body.includes("__DSH_BOOT__")) ? url : null;
	} catch { return null; }
}`),
]);

// ② alreadyRunning 分支带 entryUrl
edits.push([
Q('		return { ok: true, alreadyRunning: true, healthy: true, message: `引擎已在 ${ENGINE_PORT} 运行（HTTP 握手正常），直接打开主界面。` };'),
Q('		return { ok: true, alreadyRunning: true, healthy: true, entryUrl: await latestTokenUrl(), message: `引擎已在 ${ENGINE_PORT} 运行（HTTP 握手正常），直接打开主界面。` };'),
]);

// ③ 占用分支：node 监听者 = 引擎正在启动 → 等握手；非 node 才报外来占用
edits.push([
Q(`	if (await probe(ENGINE_PORT)) {
		const owner = portOwner(ENGINE_PORT);
		return {
			ok: false, alreadyRunning: false, occupied: true, portOwner: owner, verifyOk: null, issues: [],
			logPath: engineLogPathOf(args),
			message: \`端口 \${ENGINE_PORT} 被\${owner ? \` pid \${owner}\` : "其他进程"}占用，但它不是 dsh 引擎（HTTP 握手失败）：拒绝跳转到坏页面，也不会重复启动。请先用任务管理器确认并结束该进程。\`
		};
	}`),
Q(`	if (await probe(ENGINE_PORT)) {
		// 2026-11-24 启动器补丁（自 v0.9.1 运行时补丁移植）：开机时 DSHWebRescue（--no-open 起引擎）
		// 与本启动器会同时动作，3080 **已监听但 HTTP 握手还没就绪**是"正在启动"的正常瞬时状态
		// （0.2.2 先绑端口后注册路由，窗口期内 GET / 是 404）。旧逻辑把它当成"外来进程占用"并要求
		// 用户手动结束进程 → 用户杀掉的正是刚起来的真引擎（"每次重启都得杀 node"的自锁根因）。
		// 新逻辑：监听者是 node.exe 就当作引擎正在启动，先等握手；只有非 node 监听者才报外来占用。
		const owner = portOwner(ENGINE_PORT);
		const ownerImage = owner === null ? null : processImage(owner);
		const ownerIsNode = ownerImage !== null && /^node(\\.exe)?$/i.test(ownerImage);
		if (ownerIsNode) {
			onLog(\`端口 \${ENGINE_PORT} 上已有 node 进程（pid \${owner}）但握手未就绪：判定为引擎正在启动，最多等待 \${Math.round(args.waitMs / 1000)}s\`);
			if (await waitForEngine(ENGINE_PORT, args.waitMs, 500, engineHealth)) {
				return {
					ok: true, alreadyRunning: true, healthy: true, starting: true, entryUrl: await latestTokenUrl(),
					message: \`引擎正在启动，已就绪（pid \${owner}）。\`
				};
			}
			return {
				ok: false, alreadyRunning: false, starting: true, occupied: false, verifyOk: null, issues: [],
				logPath: engineLogPathOf(args),
				message: \`引擎进程（pid \${owner}）占着 \${ENGINE_PORT}，但 \${Math.round(args.waitMs / 1000)}s 内 HTTP 握手未就绪。⚠ 不要结束这个进程（它就是真正的引擎）：稍等后刷新本页，或到救援中心查看引擎日志。\`
			};
		}
		return {
			ok: false, alreadyRunning: false, occupied: true, portOwner: owner, verifyOk: null, issues: [],
			logPath: engineLogPathOf(args),
			message: \`端口 \${ENGINE_PORT} 被\${owner ? \` pid \${owner}\` : "其他进程"}（\${ownerImage ?? "未知映像"}）占用，且它不是 dsh 引擎（HTTP 握手失败）：拒绝跳转到坏页面，也不会重复启动。请先用任务管理器确认并结束该进程。\`
		};
	}`),
]);

// ④⑤ boot() 返回值带 entryUrl
edits.push([
Q('			start, logPath: start.log || engineLogPathOf(args),'),
Q(`			start, logPath: start.log || engineLogPathOf(args),
			entryUrl: start.ok ? await latestTokenUrl() : null,`),
]);
edits.push([
Q('		window: windowInfo, quarantined: [], logPath: engineLogPathOf(args),'),
Q(`		window: windowInfo, quarantined: [], logPath: engineLogPathOf(args),
		entryUrl: up ? await latestTokenUrl() : null,`),
]);

// ⑥⑦⑧ 页面跳转带 entryUrl
edits.push([
Q(`			log("✓ " + r.message, "ok");
			location.href = "http://127.0.0.1:\${enginePort}/";`),
Q(`			log("✓ " + r.message, "ok");
			location.href = r.entryUrl || "http://127.0.0.1:\${enginePort}/";`),
]);
edits.push([
Q('		if (r.ok) { log("✓ " + (r.message || "引擎已启动"), "ok"); setTimeout(() => location.href = "http://127.0.0.1:${enginePort}/", 600); }'),
Q('		if (r.ok) { log("✓ " + (r.message || "引擎已启动"), "ok"); setTimeout(() => location.href = r.entryUrl || "http://127.0.0.1:${enginePort}/", 600); }'),
]);
edits.push([
Q('		else if (r.quarantined && r.quarantined.length) { log("⚠ 运行期失败条目已自动隔离：" + r.quarantined.join(", "), "bad"); log("✓ " + (r.message || "重试成功"), "ok"); setTimeout(() => location.href = "http://127.0.0.1:${enginePort}/", 600); }'),
Q('		else if (r.quarantined && r.quarantined.length) { log("⚠ 运行期失败条目已自动隔离：" + r.quarantined.join(", "), "bad"); log("✓ " + (r.message || "重试成功"), "ok"); setTimeout(() => location.href = r.entryUrl || "http://127.0.0.1:${enginePort}/", 600); }'),
]);

let n = 0;
for (const [from, to] of edits) {
	const hits = src.split(from).length - 1;
	if (hits !== 1) { console.error(`✘ 命中 ${hits} 次（期望 1）:\n${from.slice(0, 120)}...`); process.exit(1); }
	src = src.replace(from, () => to);
	n++;
}
writeFileSync(FILE, src, "utf8");
console.log(`✔ 已应用 ${n} 处补丁`);
