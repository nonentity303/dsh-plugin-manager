// 示例插件（E2E 用）：cordis 插件 = 函数或带 apply 的对象。
// 无副作用：空插件，仅让 demo 条目在 loader 中正常激活。
export default function demoPlugin(ctx) {
	// 返回 dispose（可空）
	return () => {};
}
