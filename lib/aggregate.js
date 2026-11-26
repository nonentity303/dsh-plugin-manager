/**
 * aggregate.js — 多更新源版本聚合（纯函数，可单测）。
 *
 * 安全修复（CWE-494 供应链投毒）——**registry 源权威，其它源只作兜底**。
 *
 * 修复前的规则是「所有源取最高版本」：GitHub 上一个免费账号建个同名仓库、
 * 发个 v999.0.0 release，就能在默认更新流程里赢过 npm 上的真实发布，
 * 宿主再从这个伪造仓库取 release 资产（tgz / torrent / magnet / codeload）安装，
 * pnpm 安装时的生命周期脚本随即执行。**取最高版本正是这条攻击链能生效的直接原因**。
 *
 * 现在的规则：
 *  1) 只要有 registry 源给出确定版本 → 只在 registry 源之间取最高（并列随机），
 *     返回 sourceTrust: "registry"；github 等非 registry 源**一律不参与**，
 *     repo 也强制为 null（registry 源本就没有仓库概念，顺手掐断"伪造仓库"的传播）。
 *  2) registry 源都没有确定版本 → 才在所有源里取最高作为兜底，
 *     返回 sourceTrust: "fallback" + degraded: true（UI 据此提示「版本来自非官方源、未经 npm 校验」）。
 *  3) 同一信任层内并列时仍随机挑选（官方源权重一致，不偏列表顺序）。
 *  4) 向后兼容：entries 里**完全没有** type 字段时（旧调用/旧测试夹具），
 *     退化为原来的全局取最高行为，返回值也不带任何信任字段。
 */
import { compareVersions } from "./compare-versions.js";

/** 信任层：registry（npm 兼容源，权威）/ fallback（github 等非 registry 源的兜底）。 */
export const SOURCE_TRUST = Object.freeze({ REGISTRY: "registry", FALLBACK: "fallback" });

/** 取条目声明的源类型；缺失/空串返回 null（= 老夹具，不参与分级）。 */
function entryType(entry) {
	return typeof entry?.type === "string" && entry.type !== "" ? entry.type : null;
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
		// 并列：随机挑选，官方源权重一致
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
 * @param entries - [{version: string|null, sourceName, sourceUrl?, sourceType?, repo, official, type?}]（已过滤禁用源）。
 *   type = "registry" | "github"（旧夹具可能没有 type 字段）。
 * @param [options] - {trustTiers?: boolean}：trustTiers:false 强制旧行为（全局取最高），仅兼容用。
 * @returns {version, sourceName, sourceUrl, sourceType, repo, sourceTrust?, degraded?}；
 *   全部无版本时 version=null（sourceTrust/degraded 仅在分级生效时出现）。
 */
export function aggregateLatest(entries, options = {}) {
	const list = Array.isArray(entries) ? entries : [];
	const typed = list.some((entry) => entryType(entry) !== null);
	// 向后兼容：没有 type 字段（旧调用/旧夹具）或显式关闭分级 → 原行为，全局取最高
	if (!typed || options?.trustTiers === false) {
		return pickHighest(list) ?? { version: null, sourceName: null, sourceUrl: null, sourceType: null, repo: null };
	}
	const registryEntries = list.filter((entry) => entryType(entry) === SOURCE_TRUST.REGISTRY);
	if (registryEntries.length > 0) {
		// 规则 1：registry 权威 —— 非 registry 源（哪怕版本号更高）一律不参与
		const best = pickHighest(registryEntries);
		if (best !== null) return { ...best, sourceType: SOURCE_TRUST.REGISTRY, repo: null, sourceTrust: SOURCE_TRUST.REGISTRY, degraded: false };
	}
	// 规则 2：registry 没给出确定版本 → 所有源里取最高作兜底，并标记「未经 npm 校验」
	const fallback = pickHighest(list);
	if (fallback === null) return { version: null, sourceName: null, sourceUrl: null, sourceType: null, repo: null, sourceTrust: null, degraded: false };
	return { ...fallback, sourceTrust: SOURCE_TRUST.FALLBACK, degraded: true };
}
