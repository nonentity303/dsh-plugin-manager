import { createRequire } from "node:module";
import { createWriteStream, mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);

/**
 * 通用下载器：适配主流下载链接方式。
 *  - http(s) 直链 -> fetch 流式下载
 *  - magnet / .torrent -> P2P（优先本机 aria2c 外部进程，否则内置 webtorrent）
 *  - 外部下载器检测：aria2c（HTTP/magnet/torrent 全支持）、比特彗星等（无 CLI 时提示用户手动导入）
 */

/** 下载结果。 */
function makeResult(status, file, message) {
	return { status, file: file ?? null, message: message ?? null };
}

/** 判断链接类型。 */
function classifyUrl(url) {
	if (typeof url !== "string" || url === "") return "unknown";
	if (url.startsWith("magnet:")) return "magnet";
	const lower = url.toLowerCase();
	if (lower.startsWith("http://") || lower.startsWith("https://")) {
		return lower.endsWith(".torrent") ? "torrent" : "http";
	}
	if (lower.endsWith(".torrent")) return "torrent";
	return "unknown";
}

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

/** HTTP(S) 直链下载（fetch 流式，最多 10 分钟）。 */
async function downloadHttp(url, destFile, log) {
	const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	if (response.body === null) throw new Error("空响应体");
	const writer = createWriteStream(destFile);
	try {
		for await (const chunk of response.body) {
			writer.write(chunk);
		}
		await new Promise((resolve, reject) => {
			writer.end((error) => (error ? reject(error) : resolve()));
		});
	} catch (error) {
		writer.destroy();
		throw error;
	}
}

/** 通过外部下载器（aria2c）下载 http/magnet/torrent。 */
function downloadExternal(tool, url, destDir, log) {
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
			resolve(makeResult("failed", null, "外部下载器超时（10 分钟）"));
		}, 10 * 60 * 1000);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve(makeResult("failed", null, `无法启动 ${tool}: ${error.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const file = join(destDir, "p2p-download.bin");
			if (code === 0) {
				resolve(makeResult("downloaded", file, `已通过 ${tool} 下载`));
			} else {
				resolve(makeResult("failed", null, `${tool} 退出码 ${code}${stderrTail ? `：${stderrTail}` : ""}`));
			}
		});
	});
}

/** 通过内置 webtorrent 下载 magnet/.torrent。 */
function downloadWebTorrent(url, destDir, log) {
	return new Promise((resolve) => {
		let WebTorrent;
		try {
			WebTorrent = require("webtorrent");
		} catch {
			resolve(makeResult("failed", null, `未安装内置 P2P 客户端。请任选其一：\n1) 安装 aria2c 后重试（支持 HTTP/磁力/种子）\n2) 用比特彗星(BitComet)等下载工具手动导入：${url}\n3) 在插件目录执行 npm install webtorrent 启用内置 P2P`));
			return;
		}
		const client = new WebTorrent({ dht: false });
		const timer = setTimeout(() => {
			try {
				client.destroy();
			} catch {
				// ignore
			}
			resolve(makeResult("failed", null, "P2P 下载超时（10 分钟，可能无做种者）"));
		}, 10 * 60 * 1000);
		client.on("error", (error) => {
			clearTimeout(timer);
			try {
				client.destroy();
			} catch {
				// ignore
			}
			resolve(makeResult("failed", null, `P2P 客户端错误: ${error.message}`));
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
					resolve(makeResult("downloaded", file, "已通过内置 P2P 下载"));
				});
				torrent.on("error", (error) => {
					clearTimeout(timer);
					resolve(makeResult("failed", null, `P2P 种子错误: ${error.message}`));
				});
			});
		} catch (error) {
			clearTimeout(timer);
			try {
				client.destroy();
			} catch {
				// ignore
			}
			resolve(makeResult("failed", null, `P2P 添加种子失败: ${error.message}`));
		}
	});
}

/**
 * 下载一个链接到临时目录。
 * @param url - http(s) / magnet / .torrent 链接。
 * @param log - 日志函数。
 * @returns {Promise<{status, file, message}>}
 */
export async function downloadUrl(url, log = () => {}) {
	const kind = classifyUrl(url);
	if (kind === "unknown") return makeResult("failed", null, `不支持的下载链接：${url}`);
	const destDir = join(tmpdir(), `dsh-dl-${process.pid}-${randomUUID()}`);
	try {
		mkdirSync(destDir, { recursive: true });
	} catch {
		// ignore
	}
	if (kind === "http") {
		const destFile = join(destDir, "package.tgz");
		try {
			await downloadHttp(url, destFile, log);
			return makeResult("downloaded", destFile, "已通过 HTTP 直链下载");
		} catch (error) {
			return makeResult("failed", null, `HTTP 下载失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// magnet / torrent：优先外部下载器（aria2c），否则内置 webtorrent
	const external = detectExternal();
	if (external !== null) {
		log(`使用外部下载器 ${external} 下载 P2P 链接`);
		return await downloadExternal(external, url, destDir, log);
	}
	log("未检测到外部下载器（aria2c），使用内置 webtorrent 下载 P2P 链接");
	return await downloadWebTorrent(url, destDir, log);
}

/** 下载完成后清理临时文件。 */
export function cleanupDownload(file) {
	try {
		unlinkSync(file);
	} catch {
		// ignore
	}
}
