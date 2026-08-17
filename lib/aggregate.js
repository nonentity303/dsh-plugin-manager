/**
 * aggregate.js — 多更新源版本聚合（纯函数，可单测）。
 *
 * 规则：
 *  - 取所有启用源返回的**最高版本**；
 *  - 多个源并列最高时**随机挑选一个**——官方源权重一致，
 *    不偏向列表顺序（否则永远是第一个源 = 默认的 npm）。
 */
import { compareVersions } from "./compare-versions.js";

/**
 * @param entries - [{version: string|null, sourceName, repo, official}]（已过滤禁用源）。
 * @returns {version, sourceName, repo} 聚合结果；全部无版本时 version=null。
 */
export function aggregateLatest(entries) {
	let best = { version: null, sourceName: null, repo: null };
	const ties = [];
	for (const entry of entries) {
		const version = entry?.version ?? null;
		if (version === null || typeof version !== "string" || version === "") continue;
		const cmp = best.version === null ? 1 : compareVersions(version, best.version);
		if (cmp > 0) {
			best = { version, sourceName: entry.sourceName ?? null, repo: entry.repo ?? null };
			ties.length = 0;
			ties.push(entry);
		} else if (cmp === 0) {
			ties.push(entry);
		}
	}
	if (ties.length > 1) {
		// 并列：随机挑选，官方源权重一致
		const pick = ties[Math.floor(Math.random() * ties.length)];
		best = { version: best.version, sourceName: pick.sourceName ?? null, repo: pick.repo ?? null };
	}
	return best;
}
