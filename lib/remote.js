import { z } from "zod";

/**
 * Typert wire contract for the local plugin manager.
 * The client half mounts this artifact through the trusted host gateway;
 * no extra server port is opened.
 */
const phase = z.union([
	z.literal(null),
	z.literal("pending"),
	z.literal("loading"),
	z.literal("active"),
	z.literal("failed"),
	z.literal("unloading")
]);

const necessity = z.union([
	z.literal("core"),
	z.literal("recommended"),
	z.literal("optional")
]);

const entry = z.object({
	entryId: z.string(),
	configId: z.string(),
	moduleName: z.string(),
	packageName: z.string(),
	/** 功能简介（简体中文）。 */
	description: z.string(),
	/** 必要程度：core=必须(红) / recommended=推荐(黄) / optional=可选(绿)。 */
	necessity,
	enabled: z.boolean(),
	phase,
	/** 运行期错误（phase=failed 时非空）。 */
	error: z.string().nullable(),
	protected: z.boolean(),
	protectionReason: z.string().nullable(),
	installedVersion: z.string().nullable(),
	latestVersion: z.string().nullable(),
	/** true=可更新；false=已最新；null=无法确认（离线/非 npm 包）。 */
	needsUpdate: z.boolean().nullable()
}).readonly();

const snapshot = z.object({
	profileName: z.string(),
	entries: z.array(entry).readonly()
}).readonly();

const mutationItem = z.object({
	entryId: z.string(),
	status: z.union([
		z.literal("changed"),
		z.literal("restart-required"),
		z.literal("unchanged"),
		z.literal("skipped"),
		z.literal("failed")
	]),
	message: z.string().nullable()
}).readonly();

const receipt = z.object({
	enabled: z.boolean(),
	items: z.array(mutationItem).readonly(),
	snapshot
}).readonly();

const strict = (typeSymbol, schema) => ({
	mode: "strict",
	typeSymbol,
	schema
});

const parameter = (name, schema) => ({
	name,
	wire: name,
	source: "json",
	codec: strict(`@dsh-local/plugin-manager/types#${name}`, schema)
});

const descriptor = (method, parameters, result) => ({
	id: `@dsh-local/plugin-manager#pluginManagerPro/${method}`,
	service: "pluginManagerPro",
	namespace: "pluginManagerPro",
	method,
	invocation: { kind: "direct" },
	parameters,
	result: strict(`@dsh-local/plugin-manager/types#${method === "list" || method === "refresh" ? "PluginManagerSnapshot" : "MutationReceipt"}`, result)
});

const descriptors = [
	descriptor("list", [], snapshot),
	descriptor("refresh", [], snapshot),
	descriptor("setEnabled", [parameter("entryId", z.string()), parameter("enabled", z.boolean())], receipt)
];

const TYPERT_REMOTE = {
	package: "@dsh-local/plugin-manager",
	descriptors
};

/** Host Typert artifact loaded from the package's `./typert` export. */
const TYPERT = {
	package: "@dsh-local/plugin-manager",
	face: "host",
	schemas: [],
	invocations: descriptors,
	model: {
		services: [],
		events: [],
		objects: []
	}
};

export { TYPERT, TYPERT_REMOTE, TYPERT_REMOTE as default };
