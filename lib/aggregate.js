/**
 * aggregate.js — 多更新源版本聚合（纯函数，可单测）。
 *
 * 安全修复（CWE-494 供应链投毒）——**权威层是显式的服务端信任判定，不再由源类型决定**。
 *
 * 1.0.2 的规则是「type === "registry" 的源权威，其它源只作兜底」。这还留着一条攻击链：
 * `normalizeSourceType` 把"任何非 github"都归一成 registry，调用方加一个
 * `http://attacker/registry`（或客户端自报 `official:true`）就进了权威层，它的 dist-tags
 * 直接决定安装版本。1.0.3 起把「权威」独立成 `authoritative` 字段：
 *   · lib/index.js 只给内置白名单源（npm 官方 / npmmirror）或**显式 authoritative:true**
 *     （http 源还需同时 allowInsecure）的源置 authoritative:true，其余一律 false；
 *   · 本文件只按 authoritative 分层，不再看 type —— type 仍随结果带出，供安装路径判定
 *     （registry → pnpm / github → 下载器）。
 *
 * 规则：
 *  1) 有权威源给出确定版本 → 只在权威源之间取最高（并列随机），sourceTrust:"authoritative"，
 *     degraded:false，repo 置 null（权威源本就没有仓库概念，顺手掐断"伪造仓库"的传播）。
 *  2) 没有权威源版本 → 所有源取最高作兜底，sourceTrust:"fallback"、degraded:true
 *     （UI 据此提示「版本来自非权威源、未经 npm 校验」）。
 *  3) 同一信任层内并列时仍随机挑选（源权重一致，不偏列表顺序）。
 *  4) 向后兼容：
 *     · entries 里**既没有** authoritative 也**没有** type 字段（很老的调用/夹具）→
 *       退化为原来的全局取最高行为，返回值不带任何信任字段；
 *     · 只有 type 没有 authoritative（1.0.2 的测试夹具/旧调用）→ type==="registry"
 *       视作权威、"github" 视作非权威，保持旧断言语义，避免大面积改旧测试。
 */
import { compareVersions } from "./compare-versions.js";

/**
 * 信任层：authoritative（权威源）/ fallback（非权威源的兜底）。
 * REGISTRY 是 1.0.2 的旧名，值已改为 "authoritative"：只为不让旧导入/旧断言直接崩掉，
 * 新代码请用 AUTHORITATIVE。
 */
export const SOURCE_TRUST = Object.freeze({
	AUTHORITATIVE: "authoritative",
	FALLBACK: "fallback",
	REGISTRY: "authoritative"
});

/** 取条目声明的源类型；缺失/空串返回 null（= 老夹具，不参与分级）。 */
function entryType(entry) {
	return typeof entry?.type === "string" && entry.type !== "" ? entry.type : null;
}

/**
 * 条目是否属于权威层：优先看服务端字段 authoritative（boolean 才采信）；
 * 旧夹具只有 type 时按 1.0.2 语义退化（registry=权威、github=非权威）。
 */
function isAuthoritativeEntry(entry) {
	if (typeof entry?.authoritative === "boolean") return entry.authoritative === true;
	return entryType(entry) === "registry";
}

/**
 * 在一组候选里取最高版本；并列随机（同一信任层内语义不变）。
 * sourceUrl/sourceType 一并带出：调用方要按**刷新时命中的那个源**定位安装路径，
 * 按源名反查 + "查不到就随便拿一个启用源"的兜底会造成 github/registry 装法错配。
 * @returns {version, sourceName, sourceUrl, sourceType, repo} | null（没有可用版本）。
 */
function pickHighest(entries) {
	let best = null;
	const ties = [];
	for (const entry of entries) {
		const version = entry?.version ?? null;
		if (version === null || typeof version !== "string" || version === "") continue;
		const cmp = best === null ? 1 : compareVersions(version, best.version);
		if (cmp > 0) {
			best = snapshotOf(entry);
			ties.length = 0;
			ties.push(entry);
		} else if (cmp === 0) {
			ties.push(entry);
		}
	}
	if (best === null) return null;
	if (ties.length > 1) {
		// 并列：随机挑选，同一信任层内源权重一致
		const pick = ties[Math.floor(Math.random() * ties.length)];
		best = { ...best, sourceName: pick.sourceName ?? null, sourceUrl: pick.sourceUrl ?? null, sourceType: pick.sourceType ?? null, repo: pick.repo ?? null };
	}
	return best;
}

/** 从条目提炼"来源身份"字段（version 另算，并列时保留最高的那个）。 */
function snapshotOf(entry) {
	return {
		version: entry.version,
		sourceName: entry.sourceName ?? null,
		sourceUrl: entry.sourceUrl ?? null,
		// sourceType 与 type 等价：调用方装哪个源要按类型判定（registry→pnpm / github→下载器）
		sourceType: entry.sourceType ?? entry.type ?? null,
		repo: entry.repo ?? null
	};
}

/**
 * @param entries - [{version: string|null, sourceName, sourceUrl?, sourceType?, repo, authoritative?, official?, type?}]
 *   （已过滤禁用源）。authoritative 是服务端判定的信任层字段；type 只决定安装路径。
 * @param [options] - {trustTiers?: boolean}：trustTiers:false 强制旧行为（全局取最高），仅兼容用。
 * @returns {version, sourceName, sourceUrl, sourceType, repo, sourceTrust?, degraded?}；
 *   全部无版本时 version=null（sourceTrust/degraded 仅在分级生效时出现）。
 */
export function aggregateLatest(entries, options = {}) {
	const list = Array.isArray(entries) ? entries : [];
	const tiered = list.some((entry) => typeof entry?.authoritative === "boolean" || entryType(entry) !== null);
	// 向后兼容：既无 authoritative 也无 type（旧调用/旧夹具）或显式关闭分级 → 原行为，全局取最高
	if (!tiered || options?.trustTiers === false) {
		return pickHighest(list) ?? { version: null, sourceName: null, sourceUrl: null, sourceType: null, repo: null };
	}
	const authoritativeEntries = list.filter(isAuthoritativeEntry);
	if (authoritativeEntries.length > 0) {
		// 规则 1：权威层 —— 非权威源（哪怕版本号更高）一律不参与
		const best = pickHighest(authoritativeEntries);
		if (best !== null) return { ...best, repo: null, sourceTrust: SOURCE_TRUST.AUTHORITATIVE, degraded: false };
	}
	// 规则 2：权威源没给出确定版本 → 所有源里取最高作兜底，并标记「未经 npm 校验」
	const fallback = pickHighest(list);
	if (fallback === null) return { version: null, sourceName: null, sourceUrl: null, sourceType: null, repo: null, sourceTrust: null, degraded: false };
	return { ...fallback, sourceTrust: SOURCE_TRUST.FALLBACK, degraded: true };
}
