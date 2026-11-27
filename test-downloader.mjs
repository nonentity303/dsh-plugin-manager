// test-downloader.mjs — 下载器完整性校验（CWE-494）回归
// 用法: node test-downloader.mjs
//
// 全部走本机 127.0.0.1 临时 HTTP server + 随机内容，**不依赖外网**。
// 覆盖：明文 HTTP 门禁 / 无期望门禁 / 只给 size 不算校验（B1）/ 重定向逐跳协议校验（B2）/
//       SRI(integrity) 与 shasum（hex+base64）/ SRI 多算法取最强 / sha256(base64+hex) /
//       2MB 流式（不整体读内存）/ P2P 门禁 / classifyUrl 既有语义。
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyUrl, cleanupDownload, downloadUrl } from "./lib/downloader.js";

const checks = [];
const record = (name, ok, detail) => {
	checks.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
};

// ---------- 本机 HTTP server：分块流式返回，便于验证「边写边算」 ----------
const SMALL = randomBytes(64 * 1024);       // 64 KB：绝大多数用例
const BIG = randomBytes(2 * 1024 * 1024);   // 2 MB：流式/内存用例
const OTHER = randomBytes(1024);            // 1 KB：故意不匹配的内容
const hits = [];                            // 记录服务端实际收到的请求（证明门禁没联网）

async function writeInChunks(res, buf) {
	res.writeHead(200, { "content-type": "application/octet-stream" });
	for (let offset = 0; offset < buf.length; offset += 8192) {
		if (!res.write(buf.subarray(offset, offset + 8192))) await once(res, "drain");
	}
	res.end();
}

const server = createServer((req, res) => {
	const path = req.url ?? "/";
	hits.push(path);
	if (path === "/small") {
		writeInChunks(res, SMALL).catch(() => res.destroy());
		return;
	}
	if (path === "/big") {
		writeInChunks(res, BIG).catch(() => res.destroy());
		return;
	}
	// ---- 重定向夹具（B2 逐跳校验）----
	if (path === "/redir-relative") {
		// 相对 Location（无 host、无前导多余层级）：必须按当前 URL 解析
		res.writeHead(302, { location: "/small" });
		res.end();
		return;
	}
	if (path === "/redir-chain1") {
		res.writeHead(302, { location: "/redir-chain2" });
		res.end();
		return;
	}
	if (path === "/redir-chain2") {
		// 同级相对路径（不带前导 /）：相对 /redir-chain1 解析应得到 /small
		res.writeHead(301, { location: "small" });
		res.end();
		return;
	}
	if (path === "/redir-loop") {
		res.writeHead(302, { location: "/redir-loop" });
		res.end();
		return;
	}
	if (path === "/redir-to-ftp") {
		res.writeHead(302, { location: "ftp://example.com/a.tgz" });
		res.end();
		return;
	}
	if (path === "/redir-to-https") {
		// https→http→https 链的「第 3 跳」：新实现根本不会请求到这里（第 2 跳就被拦）
		res.writeHead(302, { location: "https://origin.invalid/final" });
		res.end();
		return;
	}
	res.writeHead(404, { "content-type": "text/plain" });
	res.end("not found");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const SMALL_URL = `${base}/small`;

// ---------- 摘要工具（测试侧独立算，不复用被测实现） ----------
const sri = (algo, buf) => `${algo}-${createHash(algo).update(buf).digest("base64")}`;
const sha1hex = (buf) => createHash("sha1").update(buf).digest("hex");
const sha1b64 = (buf) => createHash("sha1").update(buf).digest("base64");

// ---------- downloadUrl 自身产生的临时目录（pid 前缀）追踪 ----------
const PID_PREFIX = `dsh-dl-${process.pid}-`;
const scanTemp = () => readdirSync(tmpdir())
	.filter((name) => name.startsWith(PID_PREFIX))
	.map((name) => join(tmpdir(), name));
let baseline = new Set(scanTemp());

/** 跑一次下载，并返回「本次调用新建的临时目录」（用于证明文件是否真的被删）。 */
async function run(url, options, log) {
	baseline = new Set(scanTemp());
	const result = await downloadUrl(url, log ?? (() => {}), options);
	const fresh = scanTemp().filter((dir) => !baseline.has(dir));
	return { result, fresh };
}

try {
	// ---- 1) classifyUrl 既有语义不变 ----
	record("classifyUrl(https://…/a.tgz) === \"http\"", classifyUrl("https://example.com/a.tgz") === "http");
	record("classifyUrl(http://…/a.tgz) === \"http\"", classifyUrl("http://example.com/a.tgz") === "http");
	record("classifyUrl(https://…/a.torrent) === \"torrent\"", classifyUrl("https://example.com/a.torrent") === "torrent");
	record("classifyUrl(相对 a.torrent) === \"torrent\"", classifyUrl("a.torrent") === "torrent");
	record("classifyUrl(magnet:…) === \"magnet\"", classifyUrl("magnet:?xt=urn:btih:abcd") === "magnet");
	record("classifyUrl(ftp://…) === \"unknown\"", classifyUrl("ftp://example.com/a.tgz") === "unknown");
	record("classifyUrl(\"\") === \"unknown\"", classifyUrl("") === "unknown");

	// ---- 2) 门禁 1：明文 http:// 默认拒绝，且不联网、不落盘 ----
	{
		const logs = [];
		const { result, fresh } = await run(SMALL_URL, undefined, (line) => logs.push(line));
		record("明文 http:// 默认 blocked", result.status === "blocked", JSON.stringify(result));
		record("明文 http:// code=insecure-url", result.code === "insecure-url");
		record("明文 http:// file=null", result.file === null);
		record("明文 http:// message 说明放行方式（allowInsecure）", /allowInsecure: true/.test(result.message ?? ""));
		record("明文 http:// message 标注明文风险", /(未经加密|未加密)/.test(result.message ?? ""));
		record("明文 http:// 被拒时未发出任何 HTTP 请求", hits.length === 0, `服务端收到 ${hits.length} 次`);
		record("明文 http:// 被拒时未创建临时目录", fresh.length === 0);
		record("明文 http:// 被拒时 log 有说明", logs.length > 0);
	}

	// ---- 3) allowInsecure 放行明文，但仍要有内容期望（否则门禁 2 拒） ----
	{
		const { result } = await run(SMALL_URL, { allowInsecure: true });
		record("allowInsecure:true 但无 expect → blocked", result.status === "blocked", JSON.stringify(result));
		record("无 expect code=unverified", result.code === "unverified");
		record("无 expect 时未联网", hits.length === 0);
		record("unverified message 说明放行方式（allowUnverified）", /allowUnverified: true/.test(result.message ?? ""));
	}

	// ---- 4) 无 expect 一律拒：https 链接也拒（不依赖 insecure 门禁） ----
	{
		const { result } = await run("https://127.0.0.1:1/never.tgz");
		record("https 无 expect → blocked/unverified", result.status === "blocked" && result.code === "unverified");
	}
	{
		const { result } = await run("https://example.com/plugin.torrent");
		record("https .torrent 无 expect → blocked/unverified", result.status === "blocked" && result.code === "unverified");
	}

	// ---- 5) P2P 门禁：magnet 默认拒；allowUnverified 后不再被门禁挡 ----
	{
		const magnet = "magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=plugin.tgz";
		const { result } = await run(magnet);
		record("magnet 默认 blocked", result.status === "blocked" && result.code === "unverified", JSON.stringify(result));
		record("magnet message 点明「P2P 内容无法校验」", /P2P 内容无法校验/.test(result.message ?? ""));
	}
	{
		const magnet = "magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=plugin.tgz";
		// p2pTimeoutMs 压到 1.5s：有 aria2c 的机器也不会让测试拖 10 分钟
		const { result } = await run(magnet, { allowUnverified: true, p2pTimeoutMs: 1500 });
		record("magnet + allowUnverified 不再被门禁拒（status≠blocked / code≠unverified）",
			result.status !== "blocked" && result.code !== "unverified", JSON.stringify(result));
		record("magnet + allowUnverified 失败原因是缺下载器/超时（与门禁无关）",
			["p2p-unavailable", "p2p-timeout", "p2p-failed", "ok"].includes(result.code), `code=${result.code}`);
	}

	// ---- 6) 不支持的协议 ----
	{
		const { result } = await run("ftp://example.com/a.tgz");
		record("ftp:// → failed/unsupported-url", result.status === "failed" && result.code === "unsupported-url");
	}

	// ---- 7) allowUnverified 放行：下载成功 + message 明确标「未校验来源」/「明文风险」 ----
	{
		const { result } = await run(SMALL_URL, { allowInsecure: true, allowUnverified: true });
		record("allowUnverified 放行后下载成功", result.status === "downloaded" && result.code === "ok", JSON.stringify(result));
		record("放行后 message 标注「未校验来源」", /未校验来源/.test(result.message ?? ""));
		record("放行后 message 标注明文「可能被篡改」", /可能被篡改/.test(result.message ?? ""));
		record("放行后文件内容正确", result.file !== null && readFileSync(result.file).equals(SMALL));
		if (result.file !== null) cleanupDownload(result.file);
	}

	// ---- 8) expect.integrity 正确 → 成功 ----
	{
		const { result } = await run(SMALL_URL, { allowInsecure: true, expect: { integrity: sri("sha512", SMALL) } });
		record("integrity(sha512) 正确 → downloaded", result.status === "downloaded" && result.code === "ok", JSON.stringify(result));
		record("integrity 正确时文件内容正确", result.file !== null && readFileSync(result.file).equals(SMALL));
		record("integrity 正确时 message 提到 sha512", /sha512/.test(result.message ?? ""));
		if (result.file !== null) cleanupDownload(result.file);
	}

	// ---- 9) expect.integrity 错误 → failed/integrity-mismatch，且文件已被删除 ----
	{
		const before = hits.length;
		const { result, fresh } = await run(SMALL_URL, { allowInsecure: true, expect: { integrity: sri("sha512", OTHER) } });
		record("integrity 错误 → failed", result.status === "failed", JSON.stringify(result));
		record("integrity 错误 code=integrity-mismatch", result.code === "integrity-mismatch");
		record("integrity 错误 file=null", result.file === null);
		record("integrity 错误 message 带期望/实际摘要前缀（前 16 位）",
			/期望 [0-9a-f]{16}…/.test(result.message ?? "") && /实际 [0-9a-f]{16}…/.test(result.message ?? ""), result.message ?? "");
		record("integrity 错误确实下载过（服务端收到请求）", hits.length === before + 1 && hits.at(-1) === "/small");
		record("integrity 错误后临时文件已删除（目录存在但为空）",
			fresh.length === 1 && readdirSync(fresh[0]).length === 0, JSON.stringify(fresh));
	}

	// ---- 10) expect.shasum（npm dist.shasum：sha1 hex）正确/错误 ----
	{
		const { result } = await run(SMALL_URL, { allowInsecure: true, expect: { shasum: sha1hex(SMALL) } });
		record("shasum(sha1 hex) 正确 → downloaded", result.status === "downloaded" && result.code === "ok", JSON.stringify(result));
		record("shasum 正确时文件内容正确", result.file !== null && readFileSync(result.file).equals(SMALL));
		if (result.file !== null) cleanupDownload(result.file);
	}
	{
		const { result } = await run(SMALL_URL, { allowInsecure: true, expect: { shasum: sha1hex(OTHER) } });
		record("shasum(sha1 hex) 错误 → integrity-mismatch", result.status === "failed" && result.code === "integrity-mismatch", JSON.stringify(result));
	}

	// ---- 11) shasum 也吃 base64 形态 ----
	{
		const { result } = await run(SMALL_URL, { allowInsecure: true, expect: { shasum: sha1b64(SMALL) } });
		record("shasum(base64 形态) 正确 → downloaded", result.status === "downloaded" && result.code === "ok", JSON.stringify(result));
		if (result.file !== null) cleanupDownload(result.file);
	}

	// ---- 12) expect.size 单独存在：不是内容摘要 → 按未校验拒绝（B 报告 S4-1 / B1） ----
	{
		const before = hits.length;
		const { result, fresh } = await run(SMALL_URL, { allowInsecure: true, expect: { size: SMALL.length } });
		record("只给 size（无摘要）→ blocked/unverified", result.status === "blocked" && result.code === "unverified", JSON.stringify(result));
		record("只给 size 的文案点明「大小不是内容摘要」", /大小不是内容摘要/.test(result.message ?? ""), result.message ?? "");
		record("只给 size 被拒时未联网、未落盘", hits.length === before && fresh.length === 0, `hits+${hits.length - before} fresh=${fresh.length}`);
	}
	{
		// 显式 allowUnverified 才放行；回执只能写「仅核对大小」，不能写成「校验通过」
		const { result } = await run(SMALL_URL, { allowInsecure: true, allowUnverified: true, expect: { size: SMALL.length } });
		record("只给 size + allowUnverified → downloaded", result.status === "downloaded" && result.code === "ok", JSON.stringify(result));
		record("放行回执写「仅核对大小…未校验内容摘要」且不提「摘要校验」",
			/仅核对大小/.test(result.message ?? "") && /未校验内容摘要/.test(result.message ?? "") && !/摘要校验/.test(result.message ?? ""),
			result.message ?? "");
		record("只给 size 放行后文件内容正确", result.file !== null && readFileSync(result.file).equals(SMALL));
		if (result.file !== null) cleanupDownload(result.file);
	}
	{
		const { result, fresh } = await run(SMALL_URL, { allowInsecure: true, allowUnverified: true, expect: { size: SMALL.length + 1 } });
		record("size 错误 → failed/size-mismatch（单独 size 仍会核对）", result.status === "failed" && result.code === "size-mismatch", JSON.stringify(result));
		record("size 错误后临时文件已删除", fresh.length === 1 && readdirSync(fresh[0]).length === 0, JSON.stringify(fresh));
	}
	{
		// 有摘要 + 给了 size：两者都校验（摘要对但大小错 → 失败）
		const { result } = await run(SMALL_URL, { allowInsecure: true, expect: { integrity: sri("sha512", SMALL), size: SMALL.length + 1 } });
		record("有摘要 + size 不一致 → 仍然 size-mismatch（不是只看摘要）", result.status === "failed" && result.code === "size-mismatch", JSON.stringify(result));
	}
	{
		// 有摘要 + 正确 size：回执两者都提
		const { result } = await run(SMALL_URL, { allowInsecure: true, expect: { integrity: sri("sha512", SMALL), size: SMALL.length } });
		record("有摘要 + size 正确 → 成功且回执同时提摘要与大小",
			result.status === "downloaded" && /摘要校验/.test(result.message ?? "") && new RegExp(`${SMALL.length} 字节`).test(result.message ?? ""),
			result.message ?? "");
		if (result.file !== null) cleanupDownload(result.file);
	}

	// ---- 12b) 重定向逐跳协议校验（B 报告 S4-2 / B2） ----
	{
		const { result } = await run(`${base}/redir-relative`, { allowInsecure: true, expect: { integrity: sri("sha512", SMALL) } });
		record("相对 Location（/small）→ 正常跟随并通过校验", result.status === "downloaded" && result.code === "ok", JSON.stringify(result));
		record("相对重定向后文件内容正确", result.file !== null && readFileSync(result.file).equals(SMALL));
		if (result.file !== null) cleanupDownload(result.file);
	}
	{
		const { result } = await run(`${base}/redir-chain1`, { allowInsecure: true, expect: { integrity: sri("sha512", SMALL) } });
		record("多跳 + 同级相对 Location → 正常跟随并下载成功", result.status === "downloaded" && result.code === "ok", JSON.stringify(result));
		if (result.file !== null) cleanupDownload(result.file);
	}
	{
		const before = hits.length;
		const { result } = await run(`${base}/redir-loop`, { allowInsecure: true, allowUnverified: true });
		record("重定向超过 5 跳 → failed（不再无限跟随）", result.status === "failed" && /重定向次数超过上限/.test(result.message ?? ""), JSON.stringify(result));
		record("超限后没有落盘文件", result.file === null && hits.length - before <= 7, `requests=${hits.length - before}`);
	}
	{
		const { result } = await run(`${base}/redir-to-ftp`, { allowInsecure: true, allowUnverified: true });
		record("重定向到非 http(s) 协议 → failed", result.status === "failed" && /不支持的协议/.test(result.message ?? ""), JSON.stringify(result));
	}
	{
		// https→http→https：起点必须是 https（否则门禁 1 在入口就拒了）。本机没有可信证书，
		// 所以只把「https 起点」这一跳换成桩：第 1 跳（https）302 到本地 http server，
		// 本地 http 再 302 回 https —— 旧实现 redirect:"follow" 会一路跟到最终 https 而放行，
		// 新实现必须在第 2 跳（降级为 http 的那一跳）就拦下。
		const realFetch = globalThis.fetch;
		const httpsOrigin = "https://origin.invalid/start";
		const before = hits.length;
		globalThis.fetch = async (input, init) => {
			const href = typeof input === "string" ? input : String(input?.url ?? input);
			if (href.startsWith("https://origin.invalid/")) {
				return new Response(null, { status: 302, headers: { location: `${base}/redir-to-https` } });
			}
			return realFetch(input, init);
		};
		try {
			const { result } = await run(httpsOrigin, { expect: { integrity: sri("sha512", SMALL) } });
			record("https→http→https 链：中间跳降级 → blocked/insecure-url", result.status === "blocked" && result.code === "insecure-url", JSON.stringify(result));
			record("…文案说明是第 2 跳降级", /第 2 跳/.test(result.message ?? ""), result.message ?? "");
			record("…被降级的那一跳根本没被请求 / 没有落盘",
				!hits.slice(before).includes("/redir-to-https") && result.file === null, `hits=${hits.slice(before).join(",")}`);
		} finally {
			globalThis.fetch = realFetch;
		}
	}
	{
		// 同一套夹具在 allowInsecure:true 下允许走明文跳并成功（门禁可放行，不是一刀切拒绝重定向）
		const realFetch = globalThis.fetch;
		const httpsOrigin = "https://origin.invalid/start-ok";
		globalThis.fetch = async (input, init) => {
			const href = typeof input === "string" ? input : String(input?.url ?? input);
			if (href.startsWith("https://origin.invalid/")) {
				return new Response(null, { status: 302, headers: { location: `${base}/redir-relative` } });
			}
			return realFetch(input, init);
		};
		try {
			const { result } = await run(httpsOrigin, { allowInsecure: true, expect: { integrity: sri("sha512", SMALL) } });
			record("allowInsecure:true 时 https→http 跳可放行并下载成功", result.status === "downloaded" && result.code === "ok", JSON.stringify(result));
			if (result.file !== null) cleanupDownload(result.file);
		} finally {
			globalThis.fetch = realFetch;
		}
	}

	// ---- 13) SRI 多算法：取最强（sha512 > sha1） ----
	{
		// sha1 正确、sha512 错误：如果实现错误地用了 sha1，这里会「成功」→ 断言必须失败
		const integrity = `${sri("sha1", SMALL)} ${sri("sha512", OTHER)}`;
		const { result } = await run(SMALL_URL, { allowInsecure: true, expect: { integrity } });
		record("SRI 多算法取最强：sha1 对但 sha512 错 → 失败（证明确实用了 sha512）",
			result.status === "failed" && result.code === "integrity-mismatch", JSON.stringify(result));
	}
	{
		// sha512 正确、sha1 错误：强算法通过即可（弱算法不参与判定）
		const integrity = `${sri("sha1", OTHER)} ${sri("sha512", SMALL)}`;
		const { result } = await run(SMALL_URL, { allowInsecure: true, expect: { integrity } });
		record("SRI 多算法取最强：sha512 对（sha1 错）→ 成功",
			result.status === "downloaded" && result.code === "ok", JSON.stringify(result));
		if (result.file !== null) cleanupDownload(result.file);
	}

	// ---- 14) sha256（GitHub release asset 的 digest 是 sha256:<hex>）：base64 / hex 两种形态都吃 ----
	{
		const b64 = createHash("sha256").update(SMALL).digest("base64");
		const hex256 = createHash("sha256").update(SMALL).digest("hex");
		const { result } = await run(SMALL_URL, { allowInsecure: true, expect: { integrity: `sha256-${b64}` } });
		record("integrity(sha256 base64) 正确 → downloaded", result.status === "downloaded" && result.code === "ok", JSON.stringify(result));
		if (result.file !== null) cleanupDownload(result.file);
		// github 资产 digest = "sha256:<hex>"，去掉前缀即可直接用（不必转 base64）
		const { result: hexForm } = await run(SMALL_URL, { allowInsecure: true, expect: { integrity: `sha256-${hex256}` } });
		record("integrity 也吃十六进制形态（sha256-<hex> 直接可用）", hexForm.status === "downloaded" && hexForm.code === "ok", JSON.stringify(hexForm));
		if (hexForm.file !== null) cleanupDownload(hexForm.file);
		const { result: wrong } = await run(SMALL_URL, { allowInsecure: true, expect: { integrity: `sha256-${"f".repeat(64)}` } });
		record("integrity(sha256) 错误 → integrity-mismatch", wrong.status === "failed" && wrong.code === "integrity-mismatch", JSON.stringify(wrong));
	}

	// ---- 15) 空 expect / 无法解析的 expect：失败关闭 ----
	{
		const { result } = await run(SMALL_URL, { allowInsecure: true, expect: {} });
		record("空 expect {} → 仍按无期望拒绝（unverified）", result.status === "blocked" && result.code === "unverified", JSON.stringify(result));
	}
	{
		const before = hits.length;
		const { result, fresh } = await run(SMALL_URL, { allowInsecure: true, expect: { integrity: "deadbeef" } });
		record("无法解析的 integrity → failed/invalid-expect（不静默放行）",
			result.status === "failed" && result.code === "invalid-expect", JSON.stringify(result));
		record("expect 不可用时未联网、未落盘", hits.length === before && fresh.length === 0, `hits +${hits.length - before}`);
	}
	{
		const { result } = await run(SMALL_URL, { allowInsecure: true, expect: { size: -5 } });
		record("非法 size → failed/invalid-expect", result.status === "failed" && result.code === "invalid-expect", JSON.stringify(result));
	}

	// ---- 16) 下载本身的失败仍走原有语义 ----
	{
		const { result } = await run(`${base}/nope`, { allowInsecure: true, allowUnverified: true });
		record("HTTP 404 → failed/download-failed", result.status === "failed" && result.code === "download-failed", JSON.stringify(result));
	}

	// ---- 17) 向后兼容：两参数旧调用 / options 传 null ----
	{
		const { result } = await run(SMALL_URL);
		record("两参数旧调用不抛错（默认拒绝明文）", result.status === "blocked" && result.code === "insecure-url");
		const { result: nullOpts } = await run(SMALL_URL, null);
		record("options=null 不抛错（按默认最严格处理）", nullOpts.status === "blocked" && nullOpts.code === "insecure-url");
	}

	// ---- 18) 2MB 大文件：流式校验通过 + 内存不爆 ----
	{
		const rssBefore = process.memoryUsage().rss;
		const { result } = await run(`${base}/big`, {
			allowInsecure: true,
			expect: { integrity: sri("sha512", BIG), size: BIG.length }
		});
		const rssDelta = process.memoryUsage().rss - rssBefore;
		record("2MB 大文件 integrity+size 校验通过", result.status === "downloaded" && result.code === "ok", JSON.stringify(result));
		record("2MB 文件内容与源一致", result.file !== null && readFileSync(result.file).equals(BIG));
		record(`流式校验 RSS 增长 < 64 MB（实测 ${(rssDelta / 1048576).toFixed(1)} MB）`, rssDelta < 64 * 1024 * 1024, `delta=${rssDelta}`);
		if (result.file !== null) cleanupDownload(result.file);
	}

	// ---- 19) 代码静态断言：确实流式（没有整体读进内存的写法） ----
	{
		const src = readFileSync(new URL("./lib/downloader.js", import.meta.url), "utf8");
		record("实现里没有 readFileSync（不把包整体读进内存）", !/readFileSync/.test(src));
		record("响应体按块迭代 (for await … of response.body)", /for await \(const chunk of response\.body\)/.test(src));
		record("摘要边写边算（hash.update(buf) 在写盘循环里）", /for \(const hash of hashStates\.values\(\)\) hash\.update\(buf\);/.test(src));
		record("校验失败会 unlinkSync 删除已下载文件", /safeUnlink\(destFile\)/.test(src) && /unlinkSync\(file\)/.test(src));
		// ---- B1/B2 静态断言：语义只能靠代码保证的那部分 ----
		record("usable 只认摘要（不再把 size 算作已校验）",
			/const usable = plan\.hashes\.length > 0;/.test(src) && !/plan\.size !== null \|\| plan\.hashes\.length > 0/.test(src));
		record("HTTP 下载不再用 redirect:\"follow\"（改 manual 逐跳）",
			!/redirect: "follow"/.test(src) && /redirect: "manual"/.test(src));
		record("每一跳都用 new URL(location, current) 解析相对地址", /new URL\(location, current\)/.test(src));
		record("逐跳协议门禁在请求前生效（降级文案带「第 N 跳」）", /第 \$\{hopNo\} 跳重定向降级为明文 HTTP/.test(src));
		record("重定向有跳数上限", /MAX_REDIRECTS = 5/.test(src));
	}
} catch (error) {
	console.error("\n用例执行异常：", error?.stack ?? error);
	checks.push({ name: "用例执行无异常", ok: false, detail: String(error?.message ?? error) });
}

// ---- 清理：关服务器 + 删除本次运行留下的临时目录 ----
server.closeAllConnections?.();
await new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
for (const dir of scanTemp()) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

const failures = checks.filter((check) => !check.ok);
console.log("");
if (failures.length > 0) {
	console.error(`${failures.length}/${checks.length} 项失败：`);
	for (const failure of failures) {
		console.error(` - ${failure.name}${failure.detail === undefined ? "" : ` — ${failure.detail}`}`);
	}
	console.log("RESULT: FAIL");
	process.exitCode = 1;
} else {
	console.log(`全部 ${checks.length} 项通过`);
	console.log("RESULT: PASS");
}

// CI 稳定性（2026-11-27 实测）：本套件自建 HTTP 服务器做重定向/下载用例。`server.close()` 在
// GitHub Windows runner 上可能被残留的 keep-alive 连接拖住 → 进程不退、上层 `npm test` 的这一步
// 一直挂着，直到 30 分钟超时（master 上同样这条链只要 ~2 分钟，所以那是"卡住"不是"慢"）。
// 结果已经打印完，这里显式退出：退出码语义与 process.exitCode 一致，但不受残留句柄影响。
// 用 setTimeout 而不是立即 exit：给 stdout 一次 flush 的机会（管道输出异步）。
{
	const code = failures.length > 0 ? 1 : 0;
	setTimeout(() => process.exit(code), 200);
}
