#!/usr/bin/env node
/**
 * host-registry.mjs — **环境专属模块登记表 + 惰性装载 + 剥离清单**（1.1.0 起）。
 *
 * 目的：把「这段代码在当前环境会不会跑」从**审阅者的脑力活**变成**一张可执行的表**。
 *
 * 机制（三层，逐层可断言）：
 *   1. `lib/host-profile.mjs` 首启探测出形态（web / desktop / unknown）并落盘；
 *   2. **能力表**（`lib/capabilities.mjs`）给出该形态下每个能力是开还是关 + 中文理由；
 *   3. 本文件把「环境专属模块」登记为 `{ 能力键, 期望值 }`：**能力不满足的模块一律不 import**（= 剥离），
 *      并把"剥离了什么、为什么、多少行"输出成清单（`auditModules`），供死代码审查与 `dsh-drydock-modules` 展示。
 *
 * 硬约束（与 `test-isolation.mjs` 配套）：
 *   - 本表是**文件级**的：一个模块要么整体装载、要么整体剥离。做不到"同一文件里删几行"。
 *     所以环境专属逻辑必须独立成文件（这也是 host 侧 import 白名单的由来）。
 *   - 剥离 = **不 import**，不是"import 了但不用"；`loadModules` 的注入式 loader 让测试能证明"一次都没调用"。
 *   - 能力表查不到/形态未知时按网页版回落（与 `capabilitiesFor` 同口径），**绝不因为"可能不是桌面"就开桌面专属行为**。
 *
 * 现状（诚实登记）：本版本真正"环境互斥"的只有 `rescue-profile`（桌面形态拒绝启动 Host）。
 *   `diagnostics` / `bundles-official` 登记为"两形态都适用"，用于证明表结构；新增桌面专属模块时照抄一条即可。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { capabilitiesFor, capabilityReason } from "./capabilities.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 环境专属模块登记表。
 * - `capability: null` → 任何形态都适用（不算环境专属，但仍登记，便于审计时解释"为什么它在"）。
 * - `expect` → 该能力键取什么值时才**需要**这个模块（布尔或字符串，与能力表取值同型）。
 */
export const ENV_MODULES = Object.freeze([
	Object.freeze({
		id: "rescue-profile",
		file: "./rescue-profile.mjs",
		capability: "engineLifecycle",
		expect: "own",
		why: "走官方通道重建救援 profile 会**启动** Host；桌面形态把宿主生命周期委托给应用（engineLifecycle=delegated），所以整模块不装载 —— 这就是「剥离」最清楚的一例。"
	}),
	Object.freeze({
		id: "diagnostics",
		file: "./diagnostics.mjs",
		capability: "offlineDiagnostics",
		expect: true,
		why: "离线只读诊断：桌面版是主战场，网页版同样可用（不写盘、不碰锁、不启停进程），两形态都装载。"
	}),
	Object.freeze({
		id: "bundles-official",
		file: "./bundles-official.mjs",
		capability: null,
		why: "官方 bundle 目录（保护集 / 隐藏集 / 模板）：纯数据 + 纯函数，任何形态都要用；host 侧也静态 import 它。"
	})
]);

/** 模块绝对路径（`./x.mjs` → 本目录下绝对路径）。 */
export function modulePath(file) {
	return join(HERE, file.replace(/^\.\//, ""));
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * 计算某形态下的装载计划（**不 import 任何模块**，只算该不该）。
 * @returns {{form: string, table: object, loadable: object[], stripped: Array<{id: string, file: string, path: string, capability: string|null, value: unknown, reason: string, why: string}>}}
 */
export function planModules(form, { capabilities = capabilitiesFor, modules = ENV_MODULES } = {}) {
	const table = capabilities(form);
	const loadable = [];
	const stripped = [];
	for (const entry of modules) {
		const path = modulePath(entry.file);
		if (entry.capability === null || entry.capability === void 0) {
			loadable.push({ ...entry, path, capability: null, value: null });
			continue;
		}
		const value = table[entry.capability];
		const needed = value === entry.expect;
		if (needed) {
			loadable.push({ ...entry, path, capability: entry.capability, value });
		} else {
			stripped.push({
				...entry,
				path,
				capability: entry.capability,
				value: value === void 0 ? null : value,
				expect: entry.expect,
				// 理由优先用能力表的中文解释（"UI 上灰着也能点开看为什么"的同一套文案来源）。
				reason: capabilityReason(form, entry.capability)
			});
		}
	}
	return { form, table, loadable, stripped };
}

/**
 * 按形态装载模块：**只 import 该装的**，返回已装载的命名空间与剥离散清单。
 * @param {string} form
 * @param {{load?: (path: string) => Promise<object>, capabilities?: Function, modules?: object[]}} [opts]
 * @returns {Promise<{form: string, loaded: string[], modules: Record<string, object>, stripped: object[], failed: Array<{id: string, error: string}>}>}
 */
export async function loadModules(form, { load = null, capabilities = capabilitiesFor, modules = ENV_MODULES } = {}) {
	const plan = planModules(form, { capabilities, modules });
	const loader = typeof load === "function" ? load : (path) => import(pathToFileURL(path).href);
	const loaded = [];
	const namespaces = {};
	const failed = [];
	for (const entry of plan.loadable) {
		try {
			namespaces[entry.id] = await loader(entry.path);
			loaded.push(entry.id);
		} catch (error) {
			failed.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { form: plan.form, loaded, modules: namespaces, stripped: plan.stripped, failed };
}

/**
 * 剥离审计：给剥离清单补上**文件路径 + 行数**，回答"本环境永远不会执行哪些文件、多少行"。
 * 读不到文件不报错（记 `lines: null` 与 `missing: true`），避免审计命令因一个旧文件就整条失败。
 */
export function auditModules(form, { capabilities = capabilitiesFor, modules = ENV_MODULES, readFile = readFileSync } = {}) {
	const plan = planModules(form, { capabilities, modules });
	let totalStrippedLines = 0;
	const enriched = plan.stripped.map((entry) => {
		let lines = null;
		let missing = false;
		try {
			const text = String(readFile(entry.path, "utf8"));
			lines = text === "" ? 1 : text.split("\n").length;
		} catch {
			missing = true;
		}
		if (typeof lines === "number") totalStrippedLines += lines;
		return { ...entry, lines, missing };
	});
	let totalLoadableLines = 0;
	const loadable = plan.loadable.map((entry) => {
		let lines = null;
		try {
			const text = String(readFile(entry.path, "utf8"));
			lines = text === "" ? 1 : text.split("\n").length;
		} catch {
			// 装载清单里的文件读不到属于异常，但审计命令仍然只报告、不抛。
		}
		if (typeof lines === "number") totalLoadableLines += lines;
		return { ...entry, lines };
	});
	return {
		form: plan.form,
		loadable,
		stripped: enriched,
		totalStrippedLines,
		totalLoadableLines,
		summary: isPlainObject(plan.table) ? plan.table.id : String(form)
	};
}
