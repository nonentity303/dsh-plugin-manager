import { createRequire } from "node:module";
import { createReadStream, createWriteStream, mkdirSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);

/**
 * 通用下载器：适配主流下载链接方式。
 *  - http(s) 直链 -> fetch 流式下载（边写盘边算摘要，不整体读进内存）
 *  - magnet / .torrent -> P2P（优先本机 aria2c 外部进程，否则内置 webtorrent）
 *  - 外部下载器检测：aria2c（HTTP/magnet/torrent 全支持）、比特彗星等（无 CLI 时提示用户手动导入）
 *
 * 安全模型（CWE-494，配合 GitHub PR #4 的供应链加固；本文件负责「下载物完整性」这一环）：
 *  门禁 1 `allowInsecure`（默认 false）：明文 `http://` 默认拒绝 —— 连接不加密，内容可在传输中被篡改/劫持。
 *  门禁 2 `allowUnverified`（默认 false）：没有任何内容期望（integrity/shasum/size）的下载默认拒绝 ——
 *          无法证明下载物与发布者声明一致；P2P（magnet/.torrent）没有可比的摘要，同样默认拒绝。
 *  门禁 3 校验执行（只要给了期望就是强制）：下载完成即校验；摘要或大小不匹配 -> 删除已下载文件 + 失败。
 *
 * 返回值恒为 `{ status, file, message, code }`：
 *  - status: "downloaded" | "blocked" | "failed"
 *  - code:   "ok" | "insecure-url" | "unverified" | "invalid-expect" | "integrity-mismatch" |
 *            "size-mismatch" | "download-failed" | "p2p-unavailable" | "p2p-timeout" | "p2p-failed" |
 *            "unsupported-url" | null（历史路径未标注时）
 */

/** 下载结果（保持 {status,file,message} 三字段兼容，额外附加 code 供机器判别）。 */
function makeResult(status, file, message, code = null) {
	return { status, file: file ?? null, message: message ?? null, code };
}

/** 摘要算法参数（长度以字节计）。 */
const DIGEST_BYTES = { sha512: 64, sha384: 48, sha256: 32, sha1: 20 };
/** 算法强度排序：SRI 多个算法并存时取最强可用者。 */
const ALGO_STRENGTH = { sha512: 4, sha384: 3, sha256: 2, sha1: 1 };

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const P2P_TIMEOUT_MS = 10 * 60 * 1000;

/** 判断链接类型。 */
export function classifyUrl(url) {
	if (typeof url !== "string" || url === "") return "unknown";
	if (url.startsWith("magnet:")) return "magnet";
	const lower = url.toLowerCase();
	if (lower.startsWith("http://") || lower.startsWith("https://")) {
		return lower.endsWith(".torrent") ? "torrent" : "http";
	}
	if (lower.endsWith(".torrent")) return "torrent";
	return "unknown";
}

/** 日志/消息里截断超长 URL。 */
function shortenUrl(url) {
	const text = String(url ?? "");
	return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** 超时时长的中文展示。 */
function humanMs(ms) {
	if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000} 分钟`;
	if (ms >= 1000) return `${ms / 1000} 秒`;
	return `${ms} 毫秒`;
}

/** 删除文件（失败忽略）。 */
function safeUnlink(file) {
	try {
		unlinkSync(file);
	} catch {
		// ignore
	}
}

/** 门禁拒绝（在下载过程中发现，需要回传 code）。 */
class BlockedError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "BlockedError";
		this.code = code;
	}
}

// ---------- 摘要解析：npm SRI / shasum ----------

/** 去掉 SRI 选项后缀（`sha512-xxx?foo` 里的 `?foo`）。 */
function stripSriOptions(payload) {
	const text = String(payload ?? "");
	const q = text.indexOf("?");
	return q === -1 ? text : text.slice(0, q);
}

/** 宽松 base64 解码（容忍缺省 padding 与 base64url 字符）；不是 base64 形态返回 null。 */
function decodeBase64Loose(text) {
	let body = String(text ?? "").trim().replace(/-/g, "+").replace(/_/g, "/");
	if (body === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
	if (body.length % 4 !== 0) body += "=".repeat(4 - (body.length % 4));
	try {
		return Buffer.from(body, "base64");
	} catch {
		return null;
	}
}

/**
 * 把「某算法 + 摘要载荷」归一成 `{algo, hex}`；载荷既可以是十六进制，也可以是 base64。
 * 无法归一（长度/字符集/算法不支持）返回 null。
 */
function normalizeDigest(algo, payload) {
	const bytes = DIGEST_BYTES[algo];
	if (bytes === undefined) return null;
	const body = stripSriOptions(payload).trim();
	if (body === "") return null;
	// 1) 十六进制：长度正好等于 2*bytes 且全为 hex 字符
	if (body.length === bytes * 2 && /^[0-9a-fA-F]+$/.test(body)) return { algo, hex: body.toLowerCase() };
	// 2) base64 族：解出来正好 bytes 字节
	const decoded = decodeBase64Loose(body);
	if (decoded !== null && decoded.length === bytes) return { algo, hex: decoded.toString("hex") };
	return null;
}

/**
 * 解析 npm 风格 SRI 字符串：`sha512-<base64>`、`sha1-<base64>`，多个算法用空格分隔。
 * 返回全部可解析的条目（未排序，由调用方取最强）。
 */
function parseIntegrity(integrity) {
	if (typeof integrity !== "string" || integrity.trim() === "") return [];
	const entries = [];
	for (const token of integrity.trim().split(/\s+/)) {
		const match = /^(sha512|sha384|sha256|sha1)-(.+)$/i.exec(token);
		if (match === null) continue;
		const normalized = normalizeDigest(match[1].toLowerCase(), match[2]);
		if (normalized !== null) entries.push(normalized);
	}
	return entries;
}

/** 取最强算法（SRI 语义：支持的算法里最强的一个说了算）。 */
function pickStrongest(entries) {
	let best = null;
	for (const entry of entries) {
		if (best === null || ALGO_STRENGTH[entry.algo] > ALGO_STRENGTH[best.algo]) best = entry;
	}
	return best;
}

/**
 * 把调用方给的 `expect` 变成可执行的校验计划。
 * 返回 `{ size, hashes, problems, provided }`：
 *  - `provided:false` 表示调用方没给任何期望（门禁 2 会拒绝）
 *  - `problems` 非空表示期望本身不可用（如 integrity 拼错）—— 失败关闭，绝不当成「没给」
 */
function buildVerificationPlan(expect) {
	const plan = { size: null, hashes: [], problems: [], provided: false };
	if (expect === undefined || expect === null) return plan;
	if (typeof expect !== "object") {
		plan.provided = true;
		plan.problems.push("expect 必须是对象（{ integrity, shasum, size }）");
		return plan;
	}
	const given = (name) => expect[name] !== undefined && expect[name] !== null;
	if (!given("integrity") && !given("shasum") && !given("size")) return plan;
	plan.provided = true;
	if (given("size")) {
		const n = Number(expect.size);
		if (!Number.isInteger(n) || n < 0) plan.problems.push(`expect.size 不是非负整数（收到 ${JSON.stringify(expect.size)}）`);
		else plan.size = n;
	}
	if (given("shasum")) {
		const normalized = normalizeDigest("sha1", expect.shasum);
		if (normalized === null) plan.problems.push("expect.shasum 无法解析（应为 sha1 的 40 位十六进制，或等价的 base64）");
		else plan.hashes.push({ ...normalized, source: "expect.shasum" });
	}
	if (given("integrity")) {
		const parsed = parseIntegrity(expect.integrity);
		const strongest = pickStrongest(parsed);
		if (strongest === null) {
			plan.problems.push("expect.integrity 无法解析（应为 npm 风格 SRI，如 sha512-<base64> 或 sha1-<base64>，多算法空格分隔，取最强者）");
		} else {
			plan.hashes.push({ ...strongest, source: `expect.integrity(${strongest.algo})` });
		}
	}
	return plan;
}

/**
 * 校验下载结果。
 * @returns `{ok, code, message, verifiedAlgos}`；不匹配时 message 已说明「文件已删除」。
 */
function verifyDownload(outcome, plan) {
	const verifiedAlgos = [];
	if (plan.size !== null && outcome.bytes !== plan.size) {
		return {
			ok: false,
			code: "size-mismatch",
			verifiedAlgos,
			message: `校验失败：文件大小不匹配（期望 ${plan.size} 字节，实际 ${outcome.bytes} 字节）。已删除下载文件，未安装。`
		};
	}
	for (const entry of plan.hashes) {
		const actual = outcome.digests[entry.algo];
		if (typeof actual !== "string") {
			return {
				ok: false,
				code: "integrity-mismatch",
				verifiedAlgos,
				message: `校验失败：运行时无法计算 ${entry.algo} 摘要。已删除下载文件，未安装。`
			};
		}
		if (actual !== entry.hex) {
			return {
				ok: false,
				code: "integrity-mismatch",
				verifiedAlgos,
				message: `校验失败：${entry.algo} 摘要不匹配（期望 ${entry.hex.slice(0, 16)}…（来自 ${entry.source}），实际 ${actual.slice(0, 16)}…）。已删除下载文件，未安装。`
			};
		}
		verifiedAlgos.push(entry.algo);
	}
	return { ok: true, code: "ok", verifiedAlgos, message: null };
}

/** 在结果 message 后追加说明（不改 status/file/code）。 */
function decorate(result, suffix) {
	if (suffix === "" || result.message === null || result.message === undefined) return result;
	return { ...result, message: result.message + suffix };
}

// ---------- 外部下载器探测 / P2P ----------

/** 检测外部下载器（返回可执行名）。跨平台：Windows `where`，Linux/macOS `which`。 */
function detectExternal() {
	const lookup = process.platform === "win32" ? "where" : "which";
	const candidates = process.platform === "win32" ? ["aria2c.exe", "aria2c"] : ["aria2c"];
	for (const name of candidates) {
		try {
			const { spawnSync } = require("node:child_process");
			const result = spawnSync(lookup, [name], { encoding: "utf8", windowsHide: true });
			if (result.status === 0 && result.stdout.trim() !== "") return name;
		} catch {
			// 继续探测
		}
	}
	return null;
}

// ---------- 下载实现 ----------

/**
 * HTTP(S) 直链下载：fetch 流式写盘，同时**边写边算**摘要（不把响应体整体读进内存）。
 * @returns `{bytes, digests}`：实际字节数与各算法摘要（hex）。
 */
async function downloadHttp(url, destFile, log, hashes, allowInsecure) {
	const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "follow" });
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	if (response.body === null) throw new Error("空响应体");
	// 跟随重定向后可能被降级成明文（https -> http）：同样按门禁 1 处理
	if (!allowInsecure && /^http:\/\//i.test(response.url ?? "")) {
		throw new BlockedError(
			"insecure-url",
			`已拒绝下载：目标在重定向后降级为明文 HTTP（${shortenUrl(response.url)}），连接未加密，内容可能被篡改。如确需下载请显式传入 allowInsecure: true。`
		);
	}
	const hashStates = new Map(hashes.map((entry) => [entry.algo, createHash(entry.algo)]));
	const writer = createWriteStream(destFile);
	let bytes = 0;
	try {
		for await (const chunk of response.body) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += buf.length;
			for (const hash of hashStates.values()) hash.update(buf);
			if (!writer.write(buf)) await once(writer, "drain");
		}
		await new Promise((resolve, reject) => {
			writer.end((error) => (error ? reject(error) : resolve()));
		});
	} catch (error) {
		writer.destroy();
		throw error;
	}
	const digests = {};
	for (const [algo, hash] of hashStates) digests[algo] = hash.digest("hex");
	log(`HTTP 下载完成：${bytes} 字节${hashStates.size > 0 ? `，已流式计算 ${[...hashStates.keys()].join("/")}` : ""}`);
	return { bytes, digests };
}

/** 对已落盘文件做流式摘要（P2P 路径在调用方给了期望时用）。 */
async function hashFile(file, hashes) {
	const hashStates = new Map(hashes.map((entry) => [entry.algo, createHash(entry.algo)]));
	let bytes = 0;
	for await (const chunk of createReadStream(file)) {
		bytes += chunk.length;
		for (const hash of hashStates.values()) hash.update(chunk);
	}
	const digests = {};
	for (const [algo, hash] of hashStates) digests[algo] = hash.digest("hex");
	return { bytes, digests };
}

/** 通过外部下载器（aria2c）下载 http/magnet/torrent。 */
function downloadExternal(tool, url, destDir, log, timeoutMs) {
	return new Promise((resolve) => {
		const args = ["--dir", destDir, "--out", "p2p-download.bin", "--max-connection-per-server=16", "--seed-time=0", url];
		const child = spawn(tool, args, { windowsHide: true });
		let stderrTail = "";
		child.stderr?.on("data", (d) => {
			stderrTail = (stderrTail + String(d)).slice(-800);
		});
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// ignore
			}
			resolve(makeResult("failed", null, `外部下载器超时（${humanMs(timeoutMs)}）`, "p2p-timeout"));
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve(makeResult("failed", null, `无法启动 ${tool}: ${error.message}`, "p2p-failed"));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const file = join(destDir, "p2p-download.bin");
			if (code === 0) {
				resolve(makeResult("downloaded", file, `已通过 ${tool} 下载`, "ok"));
			} else {
				resolve(makeResult("failed", null, `${tool} 退出码 ${code}${stderrTail ? `：${stderrTail}` : ""}`, "p2p-failed"));
			}
		});
	});
}

/** 通过内置 webtorrent 下载 magnet/.torrent。 */
function downloadWebTorrent(url, destDir, log, timeoutMs) {
	return new Promise((resolve) => {
		let WebTorrent;
		try {
			WebTorrent = require("webtorrent");
		} catch {
			resolve(makeResult("failed", null, `未安装内置 P2P 客户端。请任选其一：\n1) 安装 aria2c 后重试（支持 HTTP/磁力/种子）\n2) 用比特彗星(BitComet)等下载工具手动导入：${url}\n3) 在插件目录执行 npm install webtorrent 启用内置 P2P`, "p2p-unavailable"));
			return;
		}
		const client = new WebTorrent({ dht: false });
		const timer = setTimeout(() => {
			try {
				client.destroy();
			} catch {
				// ignore
			}
			resolve(makeResult("failed", null, `P2P 下载超时（${humanMs(timeoutMs)}，可能无做种者）`, "p2p-timeout"));
		}, timeoutMs);
		client.on("error", (error) => {
			clearTimeout(timer);
			try {
				client.destroy();
			} catch {
				// ignore
			}
			resolve(makeResult("failed", null, `P2P 客户端错误: ${error.message}`, "p2p-failed"));
		});
		try {
			client.add(url, { path: destDir }, (torrent) => {
				torrent.on("done", () => {
					clearTimeout(timer);
					const file = torrent.files.length === 1
						? join(destDir, torrent.files[0].path)
						: join(destDir, torrent.name, torrent.files.find((f) => /\.(tgz|zip|tar\.gz)$/i.test(f.path))?.path ?? torrent.files[0].path);
					try {
						client.destroy();
					} catch {
						// ignore
					}
					resolve(makeResult("downloaded", file, "已通过内置 P2P 下载", "ok"));
				});
				torrent.on("error", (error) => {
					clearTimeout(timer);
					resolve(makeResult("failed", null, `P2P 种子错误: ${error.message}`, "p2p-failed"));
				});
			});
		} catch (error) {
			clearTimeout(timer);
			try {
				client.destroy();
			} catch {
				// ignore
			}
			resolve(makeResult("failed", null, `P2P 添加种子失败: ${error.message}`, "p2p-failed"));
		}
	});
}

// ---------- 统一入口 ----------

/** 创建本次下载的临时目录（门禁拒绝时不会创建，便于证明「没有碰网络/文件」）。 */
function makeDestDir() {
	const destDir = join(tmpdir(), `dsh-dl-${process.pid}-${randomUUID()}`);
	mkdirSync(destDir, { recursive: true });
	return destDir;
}

/** 归一超时参数（非法值回落默认）。 */
function normalizeTimeoutMs(value, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.max(Math.floor(n), 100), 60 * 60 * 1000);
}

/**
 * 下载一个链接到临时目录（带完整性门禁）。
 *
 * @param {string} url - http(s) / magnet / .torrent 链接。
 * @param {(line: string) => void} [log] - 日志函数。
 * @param {object} [options] - 安全选项（全部可选，缺省即最严格）：
 * @param {{integrity?: string, shasum?: string, size?: number}} [options.expect]
 *        npm 风格内容期望：`integrity` 为 SRI（如 `sha512-<base64>`，可多算法空格分隔，取最强可解析者）；
 *        `shasum` 为 npm 的 `dist.shasum`（sha1，十六进制或等价 base64）；`size` 为字节数（给了就校验）。
 * @param {boolean} [options.allowInsecure=false] - 允许明文 `http://`（放行后 message 会标注「未经加密，内容可能被篡改」）。
 * @param {boolean} [options.allowUnverified=false] - 允许「没有任何内容期望」的下载（message 会标注「未校验来源」）。
 * @param {number} [options.p2pTimeoutMs] - P2P 下载超时（默认 10 分钟；主要给测试/快速探测用）。
 * @returns {Promise<{status: "downloaded"|"blocked"|"failed", file: string|null, message: string|null, code: string|null}>}
 */
export async function downloadUrl(url, log = () => {}, options = {}) {
	const opts = options !== null && typeof options === "object" ? options : {};
	const kind = classifyUrl(url);
	if (kind === "unknown") return makeResult("failed", null, `不支持的下载链接：${shortenUrl(url)}`, "unsupported-url");

	const allowInsecure = opts.allowInsecure === true;
	const allowUnverified = opts.allowUnverified === true;
	const p2pTimeoutMs = normalizeTimeoutMs(opts.p2pTimeoutMs, P2P_TIMEOUT_MS);

	// 门禁 1：明文 HTTP（连接未加密 -> 内容可在传输中被篡改）
	if (/^http:\/\//i.test(url) && !allowInsecure) {
		const message = `已拒绝明文 HTTP 链接：${shortenUrl(url)}。连接未加密，下载内容可能在传输中被篡改或劫持，无法证明与发布者声明一致。如确需下载，请显式传入 allowInsecure: true；该链接未经加密，内容可能被篡改。`;
		log(message);
		return makeResult("blocked", null, message, "insecure-url");
	}

	// 期望解析：给了期望就必须能执行；期望本身坏了就失败关闭（绝不当成「没给」）
	const plan = buildVerificationPlan(opts.expect);
	if (plan.problems.length > 0) {
		const message = `未开始下载：期望的校验信息无法使用（${plan.problems.join("；")}）。已中止，未下载任何文件。`;
		log(message);
		return makeResult("failed", null, message, "invalid-expect");
	}
	const usable = plan.size !== null || plan.hashes.length > 0;
	const isP2P = kind === "magnet" || kind === "torrent";

	// 门禁 2：无从校验（无任何内容期望）
	if (!usable && !allowUnverified) {
		const message = isP2P
			? `已拒绝未校验的 P2P 下载（${kind}）：P2P 内容无法校验 —— 没有可与发布者声明比对的摘要，无法发现投毒或替换。放行方式：显式传入 allowUnverified: true（接受未校验来源），或改用能提供摘要的 HTTPS 直链并在 expect.integrity/expect.shasum 里给出摘要。`
			: `已拒绝未校验的下载：${shortenUrl(url)} 未提供任何内容期望（expect.integrity / expect.shasum / expect.size），无法确认下载物与发布者声明一致，存在供应链投毒（CWE-494）风险。放行方式：调用方传入 npm 的 dist.integrity（SRI，如 sha512-<base64>）或 dist.shasum（sha1）作为 expect.integrity / expect.shasum；确实拿不到摘要时，显式传入 allowUnverified: true（接受未校验来源）。`;
		log(message);
		return makeResult("blocked", null, message, "unverified");
	}

	const destDir = makeDestDir();

	if (kind === "http") {
		const destFile = join(destDir, "package.tgz");
		log(`${plan.hashes.length > 0 ? "校验下载" : "下载"}：${shortenUrl(url)}`);
		let outcome;
		try {
			outcome = await downloadHttp(url, destFile, log, plan.hashes, allowInsecure);
		} catch (error) {
			safeUnlink(destFile);
			if (error instanceof BlockedError) {
				log(error.message);
				return makeResult("blocked", null, error.message, error.code);
			}
			return makeResult("failed", null, `HTTP 下载失败: ${error instanceof Error ? error.message : String(error)}`, "download-failed");
		}
		const verified = verifyDownload(outcome, plan);
		if (!verified.ok) {
			// 校验失败必须删掉已下载文件，避免未校验内容留在磁盘上被误用
			safeUnlink(destFile);
			log(verified.message);
			return makeResult("failed", null, verified.message, verified.code);
		}
		const notes = [];
		if (verified.verifiedAlgos.length > 0) notes.push(`已通过 ${verified.verifiedAlgos.join("/")} 摘要校验`);
		if (plan.size !== null) notes.push(`大小 ${outcome.bytes} 字节符合期望`);
		if (!usable) notes.push("未校验来源（调用方显式放行 allowUnverified）");
		if (allowInsecure && /^http:\/\//i.test(url)) notes.push("明文 HTTP 未经加密，内容可能被篡改");
		const message = `已通过 HTTP 直链下载${notes.length > 0 ? `（${notes.join("；")}）` : ""}`;
		return makeResult("downloaded", destFile, message, "ok");
	}

	// magnet / torrent：优先外部下载器（aria2c），否则内置 webtorrent
	const external = detectExternal();
	let result;
	if (external !== null) {
		log(`使用外部下载器 ${external} 下载 P2P 链接`);
		result = await downloadExternal(external, url, destDir, log, p2pTimeoutMs);
	} else {
		log("未检测到外部下载器（aria2c），使用内置 webtorrent 下载 P2P 链接");
		result = await downloadWebTorrent(url, destDir, log, p2pTimeoutMs);
	}
	if (result.status !== "downloaded" || result.file === null) return result;
	// 给了期望就照样校验 P2P 产物（比门禁放行更严格）
	if (plan.hashes.length > 0 || plan.size !== null) {
		let outcome;
		try {
			outcome = await hashFile(result.file, plan.hashes);
		} catch (error) {
			safeUnlink(result.file);
			return makeResult("failed", null, `P2P 产物校验失败: ${error instanceof Error ? error.message : String(error)}`, "integrity-mismatch");
		}
		const verified = verifyDownload(outcome, plan);
		if (!verified.ok) {
			safeUnlink(result.file);
			log(verified.message);
			return makeResult("failed", null, verified.message, verified.code);
		}
		const notes = [];
		if (verified.verifiedAlgos.length > 0) notes.push(`已通过 ${verified.verifiedAlgos.join("/")} 摘要校验`);
		if (plan.size !== null) notes.push(`大小 ${outcome.bytes} 字节符合期望`);
		return decorate(result, `（${notes.join("；")}）`);
	}
	return decorate(result, "（未校验来源：调用方显式放行 allowUnverified；P2P 内容无法校验）");
}

/** 下载完成后清理临时文件。 */
export function cleanupDownload(file) {
	try {
		unlinkSync(file);
	} catch {
		// ignore
	}
}
