#!/usr/bin/env node
/**
 * tools/dev/publish-npm.mjs — 一条命令把当前版本发到 npm，并做发布后校验
 *
 * 设计口径：
 *   · **默认是 dry-run**（只打印"将会发布什么"），要真的发布必须显式加 `--apply`——避免手滑。
 *   · 发布前自动串一遍 `npm-preflight`（认证 / 2FA / 版本占用 / tarball 内容），任何 FAIL 直接中止。
 *   · 发布后自动核对 registry，并打印「24 小时冷静期」提示（pnpm 11 的 minimumReleaseAge）。
 *
 * 用法（在插件包根目录跑）：
 *   node tools/dev/publish-npm.mjs                 # 预演（不发布）
 *   node tools/dev/publish-npm.mjs --apply         # 真的发布
 *   node tools/dev/publish-npm.mjs --apply --tag next
 *   node tools/dev/publish-npm.mjs --apply --otp 123456      # 万一 token 没有 2FA 绕过能力
 *   node tools/dev/publish-npm.mjs --skip-preflight --apply  # 不建议
 *
 * 退出码：0 = 成功；1 = 失败
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const APPLY = flag("--apply");
const TAG = opt("--tag", "latest");
const OTP = opt("--otp", null);
const CACHE = resolve(opt("--cache", process.env.DSH_NPM_CACHE || join(PKG_ROOT, ".npm-cache")));
const DRY_RUN_PUBLISH = flag("--dry-run-publish"); // tag 预演也能真发（npm 的 --dry-run 不认 tag 校验）

const resolveNpmCli = () => {
  if (process.env.npm_execpath && /npm-cli\.js$/i.test(process.env.npm_execpath)) return process.env.npm_execpath;
  for (const c of [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
};
const NPM_CLI = resolveNpmCli();

let seq = 0;
const runNpm = (args, { echo = false } = {}) => {
  const outFile = join(tmpdir(), `dsh-publish-${process.pid}-${++seq}.log`);
  const fd = openSync(outFile, "w");
  let code = null;
  try {
    const r = spawnSync(NPM_CLI ? process.execPath : "npm", NPM_CLI ? [NPM_CLI, ...args] : args, {
      cwd: PKG_ROOT,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, npm_config_cache: CACHE, npm_config_loglevel: "notice" },
    });
    code = r.status;
  } finally {
    closeSync(fd);
  }
  const text = (() => {
    try {
      return readFileSync(outFile, "utf8");
    } catch {
      return "";
    } finally {
      rmSync(outFile, { force: true });
    }
  })();
  if (echo) process.stdout.write(text);
  return { code, text };
};

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

console.log(`📦 ${pkg.name}@${VERSION}  →  npm registry（tag: ${TAG}）`);
console.log(`   模式：${APPLY ? "🚀 真的发布（--apply）" : "🧪 预演（dry-run，不会写 registry）"}`);
console.log(`   npm 缓存：${CACHE}\n`);
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });

// ── 1) 前置体检 ──────────────────────────────────────────────
if (!flag("--skip-preflight")) {
  console.log("① 发布前体检（tools/dev/npm-preflight.mjs）");
  const pf = spawnSync(process.execPath, [join(HERE, "npm-preflight.mjs")], {
    cwd: PKG_ROOT,
    stdio: "inherit",
    env: { ...process.env, DSH_NPM_CACHE: CACHE },
  });
  if (pf.status !== 0) {
    console.error("\n✘ 体检未通过，已中止发布（不要绕过它——它挡的都是「发出去才发现」的问题）");
    process.exit(1);
  }
  console.log("");
} else {
  console.log("① 已跳过体检（--skip-preflight）\n");
}

// ── 2) 发布 ─────────────────────────────────────────────────
const pubArgs = ["publish", "--tag", TAG];
if (OTP) pubArgs.push("--otp", OTP);
if (!APPLY) pubArgs.push("--dry-run");

console.log(`② ${APPLY ? "发布" : "预演"}：npm ${pubArgs.join(" ")}`);
const pub = runNpm(pubArgs, { echo: true });
if (pub.code !== 0) {
  const blob = pub.text;
  let hint = "";
  if (/EOTP|one-time pass/i.test(blob)) hint = "→ 这枚 token 没有 2FA 绕过能力：改用带「Bypass 2FA」的 granular token，或临时 `--otp <6位数>`";
  else if (/E401|Unauthorized/i.test(blob)) hint = "→ 凭据无效：检查项目 .npmrc 里的 _authToken（用户级 .npmrc 里的旧 token 也可能是元凶）";
  else if (/EPUBLISHCONFLICT|cannot publish over/i.test(blob)) hint = "→ 该版本已存在：必须改 package.json 的 version 再发";
  else if (/EPERM|EACCES/i.test(blob)) hint = "→ 权限/缓存问题：用 `--cache <可写目录>` 重跑";
  console.error(`\n✘ 发布失败（退出码 ${pub.code}）${hint ? "\n" + hint : ""}`);
  process.exit(1);
}

if (!APPLY) {
  console.log("\n✅ 预演通过，没有写 registry。要真发：node tools/dev/publish-npm.mjs --apply");
  process.exit(0);
}

// ── 3) 发布后校验 ───────────────────────────────────────────
console.log("\n③ 发布后校验");
const after = runNpm(["view", pkg.name, "version", "--json"]);
const afterLatest = runNpm(["view", pkg.name, "dist-tags.latest", "--json"]);
const got = (after.text.match(/"([^"]+)"/) || [])[1] || "?";
const latest = (afterLatest.text.match(/"([^"]+)"/) || [])[1] || "?";
console.log(`   registry 上 ${pkg.name} 的最新版本：${got}`);
console.log(`   dist-tags.latest：${latest}`);

const tarballUrl = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${VERSION}.tgz`;
console.log(`   tarball：${tarballUrl}`);

console.log(`
✅ 已发布 ${pkg.name}@${VERSION}

⚠️ 24 小时冷静期（重要）：pnpm 11 的 minimumReleaseAge 默认 1440 分钟，
   直接运行 dsh plugin --profile web add ${pkg.name} 在 24 小时内可能解析到旧版或失败。
   让用户/自己立刻能装的三种写法（任选）：
     a) 显式版本号： dsh plugin --profile web add ${pkg.name}@${VERSION}
     b) profile 的 pnpm-workspace.yaml 里把 "${pkg.name}@${VERSION}" 加进 minimumReleaseAgeExclude
     c) 等满 24 小时后再用不带版本的 add

接下来建议：
   · npm deprecate ${pkg.name}@<旧版本> "在 DSH 0.1.7 上无法加载，请升级到 ${VERSION}"（如适用）
   · 打 tag 并推送：git tag v${VERSION} && git push && git push --tags
   · 若同时维护 GitHub Release：把 npm pack 出的 tgz 附到 Release 上
`);
