#!/usr/bin/env node
/**
 * channels.mjs — 发布通道的唯一事实来源读取器（离线、零依赖、无副作用）。
 *
 * 为什么需要它：`dist-tag 怎么算` 这件事以前散在三个地方（`.github/workflows/release.yml` 的
 * PowerShell 分支、`tools/dev/publish-all.mjs` 的 `--tag` 默认值、`docs/RELEASING.md` 的人工口径）。
 * 三处各写一遍，迟早互相漂移 —— 现在统一到这里，CI / 发布脚本 / 测试都调它。
 *
 * 数据源：`release/channels.json`（schema 见该文件）。
 *
 * 通道与版本号的关系（一句话）：**核心版本号只表达产品推进；"给哪个端"写进预发布标识**：
 *   - 正式版 `1.0.5`                          → 通道 web，dist-tag `latest`
 *   - 网页预发布 `1.0.5-rc.1`                  → 通道 web，dist-tag `next`
 *   - 桌面适配 `1.1.0-desktop.2`               → 通道 desktop，dist-tag `desktop`
 *   - 社区桌面 `1.1.0-community.1`             → 通道 community，dist-tag `community`（当前 disabled）
 *
 * 用法：
 *   node tools/dev/channels.mjs --print-dist-tag [--version <v>]   # 打印该版本应使用的 dist-tag
 *   node tools/dev/channels.mjs --print-channel  [--version <v>]   # 打印该版本所属通道名
 *   node tools/dev/channels.mjs --print-label    [--version <v>]   # 打印 Release 标题前缀（如「桌面」）
 *   node tools/dev/channels.mjs --check                            # 校验 channels.json 的内部一致性
 *   node tools/dev/channels.mjs --json                             # 输出解析结果（调试用）
 *
 * 退出码：0 = 正常；1 = 校验失败 / 版本号不可解析；2 = 用法错误。
 *
 * ⚠️ 只做**正判白名单**：预发布标识只认 channels.json 里登记的那几个，其余一律报错退出，
 * 不做"看着像 rc 就当 rc"的兜底（本项目历史上"排除法写参数校验"漏过 `--expects=` 这一类的坑）。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CHANNELS_FILE = join(ROOT, "release", "channels.json");
export const PACKAGE_FILE = join(ROOT, "package.json");

/** 通用版本号语法：`x.y.z` 或 `x.y.z-<id>[.<n>]`（与 gen-changelog 的口径一致，多认 desktop/community）。 */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)[.-]?(\d+)?)?$/i;

/** 读取并解析 channels.json（保留原始结构，不在这一层做兜底）。 */
export function loadChannels(file = CHANNELS_FILE) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`读不到通道配置 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new Error(`通道配置不是合法 JSON（${file}）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!doc || typeof doc !== "object" || !doc.channels || typeof doc.channels !== "object") {
    throw new Error(`通道配置缺少 channels 对象：${file}`);
  }
  return doc;
}

/** 版本号 → `{ version, base, prereleaseId, prereleaseNum }`；不可解析返回 null（不猜）。 */
export function parseVersion(version) {
  const m = VERSION_RE.exec(String(version ?? ""));
  if (m === null) return null;
  const id = m[4] === void 0 ? null : m[4].toLowerCase();
  return {
    version: String(version),
    base: `${m[1]}.${m[2]}.${m[3]}`,
    prereleaseId: id,
    prereleaseNum: m[5] === void 0 ? 0 : Number(m[5]),
  };
}

/** 某个通道登记的全部预发布标识（主标识 + 历史别名，如 web 的 `alpha` / `beta`）。 */
export function prereleaseIdsOf(channel) {
  const ids = [];
  if (typeof channel.prereleaseId === "string" && channel.prereleaseId !== "") ids.push(channel.prereleaseId);
  if (Array.isArray(channel.prereleaseAliases)) {
    for (const alias of channel.prereleaseAliases) if (typeof alias === "string" && alias !== "") ids.push(alias);
  }
  return ids;
}

/** 预发布标识 → 通道名（正判：只认配置里登记过的）。正式版返回 `null`。 */
export function channelOfPrereleaseId(prereleaseId, doc = loadChannels()) {
  if (prereleaseId === null) return null;
  for (const [name, ch] of Object.entries(doc.channels)) {
    if (prereleaseIdsOf(ch).includes(prereleaseId)) return name;
  }
  const known = Object.values(doc.channels)
    .flatMap((ch) => prereleaseIdsOf(ch))
    .join(" / ");
  throw new Error(`未登记的预发布标识「${prereleaseId}」——已知：${known}。要新增通道请先改 release/channels.json`);
}

/**
 * 版本号 → `{ channel, distTag, releaseLabel, isPrerelease, enabled }`。
 * 正式版（无 `-`）永远属于 `web` 通道的正式口（channels.json 里 releaseTag === "latest" 的那个）。
 */
export function resolveVersion(version, doc = loadChannels()) {
  const parsed = parseVersion(version);
  if (parsed === null) throw new Error(`无法解析版本号「${version}」（期望 x.y.z 或 x.y.z-<id>.<n>）`);
  const isPrerelease = parsed.prereleaseId !== null;
  const channel = isPrerelease ? channelOfPrereleaseId(parsed.prereleaseId, doc) : stableChannelName(doc);
  const ch = doc.channels[channel];
  const distTag = isPrerelease ? ch.prereleaseTag : ch.releaseTag;
  return {
    version: parsed.version,
    channel,
    distTag,
    releaseLabel: ch.releaseLabel ?? channel,
    isPrerelease,
    enabled: ch.enabled === true,
    placeholder: ch.placeholder === true,
    parsed,
  };
}

/** 正式版归属的通道 = 唯一一个 `releaseTag === "latest"` 的通道。 */
export function stableChannelName(doc = loadChannels()) {
  const names = Object.entries(doc.channels)
    .filter(([, ch]) => ch.releaseTag === "latest")
    .map(([name]) => name);
  if (names.length !== 1) {
    throw new Error(`必须有且只有一个通道的 releaseTag = "latest"（当前 ${names.length} 个：${names.join(", ") || "无"}）`);
  }
  return names[0];
}

/** 校验配置自身的内部一致性；返回 `{ ok, errors, warnings }`（不抛错，便于测试汇总）。 */
export function validateChannels(doc = loadChannels()) {
  const errors = [];
  const warnings = [];
  const entries = Object.entries(doc.channels);

  if (entries.length === 0) errors.push("channels 为空");

  const stable = entries.filter(([, ch]) => ch.releaseTag === "latest");
  if (stable.length !== 1) errors.push(`必须有且只有一个通道的 releaseTag = "latest"（当前 ${stable.length} 个）`);

  const seenPrereleaseTags = new Map();
  const seenIds = new Map();
  for (const [name, ch] of entries) {
    if (typeof ch.title !== "string" || ch.title.trim() === "") errors.push(`通道 ${name} 缺少 title`);
    if (typeof ch.enabled !== "boolean") errors.push(`通道 ${name} 的 enabled 必须是布尔值`);
    if (ch.releaseTag !== null && ch.releaseTag !== "latest") {
      errors.push(`通道 ${name} 的 releaseTag 只能是 "latest" 或 null（当前 ${JSON.stringify(ch.releaseTag)}）`);
    }
    const ids = prereleaseIdsOf(ch);
    if (ids.length === 0) {
      if (ch.enabled) errors.push(`通道 ${name} 已启用但没有 prereleaseId（预发布标识）`);
      continue;
    }
    for (const id of ids) {
      if (seenIds.has(id)) errors.push(`预发布标识重复：「${id}」同时属于 ${seenIds.get(id)} 与 ${name}`);
      seenIds.set(id, name);
    }

    const tag = ch.prereleaseTag;
    if (typeof tag !== "string" || tag === "") {
      errors.push(`通道 ${name} 缺少 prereleaseTag`);
    } else if (tag === "latest") {
      errors.push(`通道 ${name} 的 prereleaseTag 不能是 latest（红线：预发布绝不能顶掉 latest）`);
    } else if (seenPrereleaseTags.has(tag)) {
      errors.push(`dist-tag 重复：「${tag}」同时被 ${seenPrereleaseTags.get(tag)} 与 ${name} 使用`);
    } else {
      seenPrereleaseTags.set(tag, name);
    }
  }

  for (const [name, ch] of entries) {
    if (ch.placeholder === true && ch.enabled === true) {
      warnings.push(`通道 ${name} 标了 placeholder 却 enabled=true —— 占位通道应保持禁用，避免误发`);
    }
    if (ch.enabled === true && ch.placeholder !== true && ch.install && Object.keys(ch.install).length === 0) {
      warnings.push(`通道 ${name} 已启用但没写 install 命令（文档里会缺安装口径）`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ──────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────
function readPackageVersion(file = PACKAGE_FILE) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).version;
  } catch {
    return null;
  }
}

export function main(argv = process.argv.slice(2)) {
  const opt = (name, fallback = null) => {
    const i = argv.indexOf(name);
    if (i < 0) return fallback;
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : fallback;
  };
  const known = ["--print-dist-tag", "--print-channel", "--print-label", "--check", "--json", "--version", "--help", "-h"];
  const unknown = argv.filter((a, i) => !known.includes(a) && !(i > 0 && argv[i - 1] === "--version"));
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(" ")}`);
    console.error("用法：node tools/dev/channels.mjs [--print-dist-tag|--print-channel|--print-label|--check|--json] [--version <v>]");
    return 2;
  }
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log("用法：node tools/dev/channels.mjs [--print-dist-tag|--print-channel|--print-label|--check|--json] [--version <v>]");
    return argv.length === 0 ? 2 : 0;
  }

  let doc;
  try {
    doc = loadChannels();
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 1;
  }

  if (argv.includes("--check")) {
    const { ok, errors, warnings } = validateChannels(doc);
    for (const w of warnings) console.error(`WARN  ${w}`);
    for (const e of errors) console.error(`FAIL  ${e}`);
    if (!ok) return 1;
    console.log(`CHANNELS OK: ${Object.keys(doc.channels).join(", ")}`);
    return 0;
  }

  const version = opt("--version", readPackageVersion());
  if (!version) {
    console.error("拿不到版本号：请传 --version <v>，或确保 package.json 可读");
    return 1;
  }

  let resolved;
  try {
    resolved = resolveVersion(version, doc);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 1;
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify(resolved, null, 2));
    return 0;
  }
  if (argv.includes("--print-channel")) {
    console.log(resolved.channel);
    return 0;
  }
  if (argv.includes("--print-label")) {
    console.log(resolved.releaseLabel);
    return 0;
  }
  if (!resolved.enabled) {
    console.error(`通道 ${resolved.channel} 当前为禁用状态（placeholder=${resolved.placeholder}），拒绝发布 ${resolved.version}`);
    return 1;
  }
  console.log(resolved.distTag);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
