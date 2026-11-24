import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, isSeq, isMap } from "yaml";

const PATCH_FILENAME = "cordis.patch.yml";
const OWNER_MARKER = "Managed by dsh-plugin-manager-pro. Remove this row to return control to higher-level configuration.";

/**
 * 验证 profile：检查 bundles 可解析性 + patch 可解析性
 * @param {string} profileDir - Profile 目录路径，如 C:\Users\<u>\.dsh\profiles\web
 * @returns {{ok: boolean, issues: Array<{name: string, reason: string}>}} 验证结果
 */
export function verifyProfile(profileDir) {
	const issues = [];
	const manifestPath = join(profileDir, "package.json");
	let manifest;
	
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		return { 
			ok: false, 
			issues: [{ 
				name: "package.json", 
				reason: `无法解析: ${error instanceof Error ? error.message : String(error)}` 
			}] 
		};
	}
	
	const bundles = manifest?.dsh?.profile?.bundles ?? [];

	// 已被 patch 隔离（disabled: true）的 bundle 不算问题：loader 会跳过它们，引擎仍可启动
	const quarantined = new Set();
	const patchPath = join(profileDir, PATCH_FILENAME);
	if (existsSync(patchPath)) {
		try {
			const patchDoc = parseDocument(readFileSync(patchPath, "utf8"));
			const patchSeq = patchDoc.toJS?.();
			if (Array.isArray(patchSeq)) {
				for (const item of patchSeq) {
					if (item !== null && typeof item === "object" && item.disabled === true && typeof item.name === "string") {
						quarantined.add(item.name);
					}
				}
			}
		} catch { /* patch 解析失败由下方统一报告 */ }
	}

	for (const bundle of bundles) {
		if (quarantined.has(bundle)) continue;
		if (!resolveBundleExportsPatch(bundle, profileDir)) {
			issues.push({ 
				name: bundle, 
				reason: "bundle 不可解析（包未安装或未声明 dsh.bundle），引擎将无法启动。" 
			});
		}
	}
	
	if (existsSync(patchPath)) {
		const doc = parseDocument(readFileSync(patchPath, "utf8"));
		if (doc.errors.length > 0) {
			issues.push({ 
				name: PATCH_FILENAME, 
				reason: `YAML 解析失败: ${doc.errors.map((e) => e.message).join("; ")}` 
			});
		} else if (!Array.isArray(doc.toJS())) {
			issues.push({ 
				name: PATCH_FILENAME, 
				reason: "不是顶层数组（boot 会失败）。" 
			});
		}
	}
	
	return { ok: issues.length === 0, issues };
}

/**
 * 修复 profile：隔离坏 bundle 并修复损坏的 patch
 * @param {string} profileDir - Profile 目录路径
 * @returns {{ok: boolean, quarantined: string[], message: string}} 修复结果
 */
export function fixProfile(profileDir) {
	const actions = [];
	const quarantined = [];
	const manifestPath = join(profileDir, "package.json");
	let manifest;
	
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		return { 
			ok: false, 
			quarantined, 
			message: `package.json 无法解析: ${error instanceof Error ? error.message : String(error)}` 
		};
	}
	
	const bundles = manifest?.dsh?.profile?.bundles ?? [];
	const broken = bundles.filter((bundle) => !resolveBundleExportsPatch(bundle, profileDir));

	// 隔离方式：往 cordis.patch.yml 写 {id, name, disabled: true}（带归属标记，可逆），
	// 不改动 package.json 的 bundles 列表（与插件管理器一贯的 patch 开关机制一致）。
	const patchPath = join(profileDir, PATCH_FILENAME);
	let patchDoc;
	let rebuiltPatch = false;

	if (existsSync(patchPath)) {
		patchDoc = parseDocument(readFileSync(patchPath, "utf8"));
		if (patchDoc.errors.length > 0 || !isSeq(patchDoc.contents)) {
			const backup = `${patchPath}.rescue-bak-${Date.now()}`;
			writeFileSync(backup, readFileSync(patchPath, "utf8"), "utf8");
			patchDoc = parseDocument("[]\n");
			rebuiltPatch = true;
			actions.push(`cordis.patch.yml 损坏，已备份 ${backup} 并重建`);
		}
	} else {
		patchDoc = parseDocument("[]\n");
	}
	const sequence = patchDoc.contents;

	if (broken.length > 0 && !rebuiltPatch) {
		const backup = `${patchPath}.rescue-bak-${Date.now()}`;
		writeFileSync(backup, readFileSync(patchPath, "utf8"), "utf8");
		actions.push(`隔离前已备份 ${backup}`);
	}
	for (const bundle of broken) {
		let existing = null;
		for (const item of sequence.items) {
			if (isMap(item) && item.get("name") === bundle) { existing = item; break; }
		}
		if (existing !== null) {
			existing.set("disabled", true);
		} else {
			const node = patchDoc.createNode({ id: bundle, name: bundle, disabled: true });
			node.commentBefore = OWNER_MARKER;
			sequence.add(node);
		}
		actions.push(`已隔离坏 bundle: ${bundle}`);
		quarantined.push(bundle);
	}

	if (broken.length > 0 || rebuiltPatch) {
		const serialized = String(patchDoc);
		const temporary = `${patchPath}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temporary, serialized.endsWith("\n") ? serialized : `${serialized}\n`, "utf8");
		renameSync(temporary, patchPath);
	}
	
	return { 
		ok: true, 
		quarantined, 
		message: actions.length > 0 ? actions.join("；") : "无需修复" 
	};
}

/**
 * 运行期失败条目自动隔离（v0.8.1）：静态自检无法发现「能解析但启动即抛错」的
 * 插件（如插件与引擎版本不兼容，loader 报 failed to apply loader entry <id> (<name>)），
 * 从引擎启动日志提取失败条目并写入 patch 隔离行（disabled: true，带归属标记，可逆），
 * 下次启动时 loader 会跳过它们 —— 引擎即可恢复启动（替换/更新该插件后可手动移除隔离行）。
 * @param {string} profileDir - Profile 目录路径
 * @param {string} logText - 引擎启动日志文本
 * @returns {{isolated: string[], message: string}}
 */
export function isolateFailedEntries(profileDir, logText) {
	const seen = new Map();
	if (typeof logText === "string") {
		const re = /failed to apply loader entry ([^\s(]+) \(([^)]+)\)/g;
		let m;
		while ((m = re.exec(logText)) !== null) {
			const id = m[1];
			const name = m[2];
			if (name.startsWith("cordis:")) continue;
			seen.set(name, id);
		}
	}
	if (seen.size === 0) return { isolated: [], message: "日志中未识别到加载失败条目。" };

	const patchPath = join(profileDir, PATCH_FILENAME);
	let patchDoc;
	try {
		patchDoc = existsSync(patchPath) ? parseDocument(readFileSync(patchPath, "utf8")) : parseDocument("[]\n");
		if (patchDoc.errors.length > 0 || !isSeq(patchDoc.contents)) {
			const backup = `${patchPath}.rescue-bak-${Date.now()}`;
			if (existsSync(patchPath)) writeFileSync(backup, readFileSync(patchPath, "utf8"), "utf8");
			patchDoc = parseDocument("[]\n");
		}
	} catch {
		patchDoc = parseDocument("[]\n");
	}
	const sequence = patchDoc.contents;
	const isolated = [];
	for (const [name, id] of seen) {
		let existing = null;
		for (const item of sequence.items) {
			if (isMap(item) && item.get("name") === name) { existing = item; break; }
		}
		if (existing !== null) {
			if (existing.get("disabled") !== true) {
				existing.set("disabled", true);
				isolated.push(name);
			}
		} else {
			const node = patchDoc.createNode({ id, name, disabled: true });
			node.commentBefore = OWNER_MARKER;
			sequence.add(node);
			isolated.push(name);
		}
	}
	if (isolated.length === 0) return { isolated, message: "失败条目已在隔离状态。" };
	let backup = null;
	if (existsSync(patchPath)) {
		backup = `${patchPath}.rescue-bak-${Date.now()}`;
		writeFileSync(backup, readFileSync(patchPath, "utf8"), "utf8");
	}
	const serialized = String(patchDoc);
	const temporary = `${patchPath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, serialized.endsWith("\n") ? serialized : `${serialized}\n`, "utf8");
	renameSync(temporary, patchPath);
	return { isolated, message: `已隔离运行期失败条目：${isolated.join(", ")}${backup ? `（备份 ${backup}）` : ""}` };
}

/**
 * 检查一个 bundle 是否可解析且声明 dsh.bundle
 * @param {string} bundle - Bundle 名称
 * @param {string} profileDir - Profile 目录路径
 * @returns {boolean} 是否可解析
 */
function resolveBundleExportsPatch(bundle, profileDir) {
	const rel = bundle.startsWith("@") ? bundle.split("/").slice(0, 2).join("/") : bundle.split("/")[0];
	const candidates = [];
	
	if (profileDir) candidates.push(join(profileDir, "node_modules", rel));
	
	// 全局 npm 根目录查找
	const npmGlobalRoots = [
		process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : null,
		join(process.env.LOCALAPPDATA || process.env.APPDATA, "npm", "node_modules"),
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
		"/opt/homebrew/lib/node_modules",
		"/usr/local/share/npm/lib/node_modules"
	].filter(Boolean);
	
	for (const npmRoot of npmGlobalRoots) {
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