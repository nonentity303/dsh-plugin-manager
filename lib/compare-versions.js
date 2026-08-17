/**
 * compare-versions.js — 极简 semver 比较（含 -rc.N / -alpha.N 等预发布段）。纯函数，可单测。
 * 返回 a>b ? 1 : a<b ? -1 : 0。
 */
export function compareVersions(a, b) {
	const [coreA, preA = null] = a.split("-", 2);
	const [coreB, preB = null] = b.split("-", 2);
	const cmp = compareCore(coreA, coreB);
	if (cmp !== 0) return cmp;
	if (preA === preB) return 0;
	if (preA === null) return 1;   // 正式版 > 预发布
	if (preB === null) return -1;
	return comparePre(preA, preB);
}

function compareCore(a, b) {
	const pa = a.split(".").map((part) => (part === "" ? 0 : Number(part)));
	const pb = b.split(".").map((part) => (part === "" ? 0 : Number(part)));
	const length = Math.max(pa.length, pb.length);
	for (let i = 0; i < length; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x > y ? 1 : -1;
	}
	return 0;
}

/** 预发布段比较（semver 规则：数字段 < 字母段；同类型按数值/字典序；少段 < 多段）。 */
function comparePre(a, b) {
	const pa = a.split(".");
	const pb = b.split(".");
	const length = Math.max(pa.length, pb.length);
	for (let i = 0; i < length; i++) {
		const x = pa[i] ?? "";
		const y = pb[i] ?? "";
		if (x === y) continue;
		if (x === "") return -1;            // 少一段 < 多一段
		if (y === "") return 1;
		const nx = /^\d+$/.test(x) ? Number(x) : null;
		const ny = /^\d+$/.test(y) ? Number(y) : null;
		if (nx !== null && ny !== null) return nx > ny ? 1 : -1;
		if (nx !== null) return -1;         // 数字段 < 字母段
		if (ny !== null) return 1;
		return x > y ? 1 : -1;              // 字母段：字典序
	}
	return 0;
}
