#!/usr/bin/env node
/**
 * tools/dev/publish-all.mjs — npm + GitHub 双平台发布：一条命令、幂等、可重入
 *
 * 为什么需要它（本机网络现状）：
 *   · 本机对 github.com 的 HTTPS git 协议会间歇性重置（见 E:\harness\dev-docs\Git上传指南.md），
 *     所以 git 侧必须走 SSH 443 通道；`gh`（HTTPS API）则一直稳定。
 *   · npm 对**新包名**首发走 staged publishing：先落 0.0.0-stage 占位，几分钟后真版本才可见。
 *     → 任何"发完立刻验证"的一次性脚本都会翻车；真正需要的是"失败也能原地重跑"。
 *
 * 它做的事（一条命令串起来）：
 *   [1/5] preflight  环境体检（SSH remote / gh 登录 / npm 凭据 / 版本占用）—— 只读
 *   [2/5] pack       build.mjs + npm pack（复用 tools/dev/pack.mjs）→ tgz + sha256
 *   [3/5] npm        复用 tools/dev/publish-npm.mjs --apply --tag <tag>（已在 registry 上则跳过）
 *   [4/5] gh         打 tag（SSH push）+ gh release create + 上传 tgz（已存在则只补缺失资产）
 *   [5/5] verify     三方口径校验（dist-tags / Release 资产 sha256 / verify-triple 逐文件比对）
 *   末尾             npm 周/月下载量 + GitHub 各 Release 资产下载数 并排统计（失败不影响结论）
 *
 * 幂等 / 断点续传：
 *   · 状态文件 `<仓库根>/.publish-state.json`（已加 .gitignore），每步完成即**原子写**（tmp + rename）。
 *   · 任一步失败：退出码非 0，但**已完成的步骤保持 done**，stderr 尾部写进 lastError。
 *   · `--resume`：读状态文件，只补没做成的步骤；npm 已存在 / 资产 sha256 一致时直接 SKIP。
 *   · 绝不静默成功：每步打印 `[i/5] <step> ⇒ OK|SKIP|FAIL|PENDING|DRY（原因）`，末尾汇总表。
 *
 * 安全默认：
 *   · **默认 dry-run**（只打印将要执行的命令，不写 registry / 不建 release / 不写状态文件）。
 *   · 真执行必须显式 `--apply`（与 tools/dev/publish-npm.mjs 同一口径）。
 *   · `--tag` 默认 `next`（rc 版绝不覆盖 latest）；`--tag latest` 必须再加 `--yes`。
 *   · 脚本永不删除 / 覆盖已存在的远端资产：sha256 不一致就报错让人决定。
 *
 * 用法（在插件包根目录跑）：
 *   node tools/dev/publish-all.mjs --status                  # 只查状态（零写入）
 *   node tools/dev/publish-all.mjs                           # dry-run：打印每一步将要做什么
 *   node tools/dev/publish-all.mjs --apply                   # 真发布（默认 --tag next）
 *   node tools/dev/publish-all.mjs --apply --tag latest --yes
 *   node tools/dev/publish-all.mjs --apply --skip-npm        # 只补 GitHub 侧
 *   node tools/dev/publish-all.mjs --apply --skip-gh         # 只补 npm 侧
 *   node tools/dev/publish-all.mjs --resume                  # 断点续传（dry-run，看会补哪几步）
 *   node tools/dev/publish-all.mjs --apply --resume          # 断点续传（真执行）
 *   node tools/dev/publish-all.mjs --apply --otp 123456      # token 没有 Bypass 2FA 时
 *   node tools/dev/publish-all.mjs --apply --wait 180        # 发完轮询 registry，等 staged publishing 落库
 *   node tools/dev/publish-all.mjs --apply --channel desktop  # 走桌面通道（dist-tag 由 release/channels.json 派生）
 *
 * 多通道（2026-11-27 起）：
 *   · 通道口径的唯一事实来源是 `release/channels.json`（经 tools/dev/channels.mjs 解析）；
 *     版本号里的预发布标识即通道：`-rc.N` → next、`-desktop.N` → desktop、`-community.N` → community、
 *     无后缀的正式版 → latest。
 *   · `--channel <name>` 是**可选**的显式确认：给了就必须与版本号推断出的通道一致，
 *     且会把 dist-tag 直接对齐到该通道（这时不用再手写 --tag）。
 *   · 不给 `--channel` 时保持旧行为（默认 --tag next），但会打印推断结果并警告 tag 与通道不一致。
 *
 * 退出码：0 = 全部 OK/SKIP；1 = 有 FAIL/PENDING；2 = 用法错误（参数互斥 / latest 未确认 / 通道不符）
 *
 * 设计注记（改之前先看）：
 *   1. 子进程一律 stdio 重定向到临时文件再读回——受限沙箱下 pipe 会 EPERM（见 npm-preflight.mjs 注释）。
 *   2. npm 走 `node <npm-cli.js>`，不裸 spawn `npm`（Windows 上 npm.cmd 在 Node ≥18.20 会 EINVAL）。
 *   3. 工具是"可注入"的：main(argv, deps) 里 deps.run / deps.httpsGetJson / deps.log / deps.root 都可替换，
 *      tools/dev/test-publish-all.mjs 靠这个在临时目录 + 假执行器上跑完全部用例，不碰真网络、不真发布。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadChannels, resolveVersion } from "./channels.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..", "..");

/** 固定 5 步（顺序即执行顺序；--resume 按这里的名字判断"已完成"）。 */
export const STEPS = ["preflight", "pack", "npm", "gh", "verify"];
const STATE_NAME = ".publish-state.json";
const NPM_DL_API = "https://api.npmjs.org/downloads/point";

// ──────────────────────────────────────────────────────────────
// 小工具
// ──────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const isPrerelease = (v) => typeof v === "string" && v.includes("-");
const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "—");

/** 取输出最后 n 行非空行（错误提示只留尾巴，别把整屏日志塞进状态文件）。 */
function tailLines(text, n = 12) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  return lines.slice(-n).join("\n");
}

/** 阻塞等待（只用于 --wait 轮询 registry）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 git remote 地址解析 `owner/repo`（只认 github.com 的 SSH / HTTPS 形式）。 */
export function parseGhSlugFromUrl(url) {
  const m = String(url || "").trim().match(/^(?:git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/|https?:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** 从 package.json 的 repository.url 兜底解析。 */
function slugFromPkg(pkg) {
  const raw = pkg && pkg.repository && (pkg.repository.url || pkg.repository);
  return parseGhSlugFromUrl(raw);
}

/** GitHub 资产的 sha256：优先用 digest 字段，其次用本项目惯例的 label 里的 SHA256。 */
export function assetSha256(asset) {
  if (!asset) return null;
  const d = String(asset.digest || "");
  const m = /^sha256:([0-9a-f]{64})$/i.exec(d);
  if (m) return m[1].toLowerCase();
  const m2 = /SHA256\s+([0-9a-f]{64})/i.exec(String(asset.label || ""));
  if (m2) return m2[1].toLowerCase();
  return null;
}

// ──────────────────────────────────────────────────────────────
// 参数解析
// ──────────────────────────────────────────────────────────────
export function parseArgs(argv = []) {
  const has = (n) => argv.includes(n);
  const opt = (n, d = null) => {
    const i = argv.indexOf(n);
    if (i < 0) return d;
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : d;
  };
  return {
    help: has("--help") || has("-h"),
    status: has("--status"),
    apply: has("--apply"),
    resume: has("--resume"),
    skipNpm: has("--skip-npm"),
    skipGh: has("--skip-gh"),
    yes: has("--yes"),
    json: has("--json"),
    tag: opt("--tag", "next"),
    channel: opt("--channel", null),
    otp: opt("--otp", null),
    branch: opt("--branch", null),
    cache: opt("--cache", null),
    waitMs: Math.max(0, Number(opt("--wait", "0")) || 0) * 1000,
  };
}

// ──────────────────────────────────────────────────────────────
// 真实执行器 / npm CLI 定位 / HTTPS 取数（全部可被测试替换）
// ──────────────────────────────────────────────────────────────

/** 复刻 npm-preflight.mjs / pack.mjs 的定位逻辑（pack.mjs 顶层有副作用，不能 import）。 */
export function resolveNpmCli(env = process.env, exists = existsSync) {
  if (typeof env.npm_execpath === "string" && /npm-cli\.js$/i.test(env.npm_execpath)) return env.npm_execpath;
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    typeof env.APPDATA === "string" && env.APPDATA !== "" ? join(env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js") : null,
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (exists(c)) return c;
    } catch {
      /* 单个候选探测失败不影响其余 */
    }
  }
  return null;
}

/**
 * 真实执行器：run(cmd, args, {cwd, timeoutMs, env}) → {code, stdout, stderr}
 * stdio 落临时文件而不是 pipe：受限沙箱里 pipe 会 EPERM，而且"输出一定拿得到"。
 */
export function createRealRun(defaultCwd = PKG_ROOT) {
  let seq = 0;
  return (cmd, args = [], opts = {}) => {
    const id = `${process.pid}-${++seq}`;
    const outFile = join(tmpdir(), `dsh-puball-${id}.out`);
    const errFile = join(tmpdir(), `dsh-puball-${id}.err`);
    const fo = openSync(outFile, "w");
    const fe = openSync(errFile, "w");
    let code = null;
    let spawnError = null;
    const t0 = Date.now();
    try {
      const r = spawnSync(cmd, args, {
        cwd: opts.cwd || defaultCwd,
        stdio: ["ignore", fo, fe],
        env: { ...process.env, ...(opts.env || {}) },
        timeout: opts.timeoutMs || 600000,
      });
      code = r.status;
      if (r.error) spawnError = r.error.message;
    } catch (e) {
      spawnError = e && e.message;
    } finally {
      try {
        closeSync(fo);
      } catch {
        /* ignore */
      }
      try {
        closeSync(fe);
      } catch {
        /* ignore */
      }
    }
    let stdout = "";
    let stderr = "";
    try {
      stdout = readFileSync(outFile, "utf8");
    } catch {
      /* ignore */
    }
    try {
      stderr = readFileSync(errFile, "utf8");
    } catch {
      /* ignore */
    }
    rmSync(outFile, { force: true });
    rmSync(errFile, { force: true });
    if (spawnError) {
      code = code ?? -1;
      stderr = `[spawn error] ${spawnError}\n${stderr}`;
    }
    return { code, stdout, stderr, ms: Date.now() - t0 };
  };
}

/**
 * 取 JSON：**用 Node 的 https**（本机 PowerShell/.NET 的证书链在沙箱里不可用，Node 可以）。
 * 超时/被墙/非 200 一律 reject，由调用方翻译成 `unavailable`，绝不让统计把发布流程带崩。
 */
export function defaultHttpsGetJson(url, { timeoutMs = 8000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = https.get(
      url,
      { headers: { accept: "application/json", "user-agent": "dsh-drydock-publish-all" }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
          if (data.length > 4_000_000) {
            req.destroy(new Error("响应过大"));
          }
        });
        res.on("end", () => {
          try {
            resolvePromise(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON 解析失败：${e.message}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`超时 ${timeoutMs}ms`)));
    req.on("error", (e) => reject(e));
  });
}

// ──────────────────────────────────────────────────────────────
// 状态文件：原子写（tmp + rename），读不全会当没有
// ──────────────────────────────────────────────────────────────
export const statePath = (root) => join(root, STATE_NAME);

export function readState(root) {
  const p = statePath(root);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // 半截文件：宁可从零开始，也不要基于坏状态做决定
  }
}

/** 原子写：先写 `<state>.tmp-<pid>`，再 rename 覆盖。中途崩掉只会留 tmp，不会留半截 JSON。 */
export function writeState(root, state) {
  const target = statePath(root);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`, "utf8");
  try {
    renameSync(tmp, target);
  } catch (e) {
    // 极端情况下 rename 失败（目标被占用）：留 tmp 供人工取，但不要假成功
    throw new Error(`状态文件 rename 失败（${e.message}）；tmp 保留在 ${tmp}`);
  }
  return target;
}

// ──────────────────────────────────────────────────────────────
// 上下文
// ──────────────────────────────────────────────────────────────
function buildContext(opts, deps, pkg, root) {
  const log = deps.log || ((line = "") => process.stdout.write(`${line}\n`));
  const run = deps.run || createRealRun(root);
  const npmCli = resolveNpmCli();
  // 沙箱里用户级 npm 缓存（%LOCALAPPDATA%\npm-cache）不可写 → 一律指到仓库内（已 .gitignore），
  // 与 npm-preflight.mjs / publish-npm.mjs 的口径一致（否则 view 会 EPERM 并返回错误 JSON）。
  const cache = resolve(opts.cache || process.env.DSH_NPM_CACHE || join(root, ".npm-cache"));
  if (deps.run === undefined && !existsSync(cache)) {
    try {
      mkdirSync(cache, { recursive: true });
    } catch {
      /* 建不出来就让 npm 自己报错 */
    }
  }
  const npmEnv = { npm_config_cache: cache, npm_config_loglevel: "notice" };
  const ctx = {
    opts,
    root,
    pkg,
    version: pkg.version,
    tag: opts.tag,
    log,
    run,
    httpsGetJson: deps.httpsGetJson || defaultHttpsGetJson,
    npmCli,
    cache,
    dry: !opts.apply,
    writable: !!opts.apply,
    resume: !!opts.resume,
    state: null,
    slug: null,
    branch: null,
    remoteUrl: null,
    npm(args, o = {}) {
      const cmd = npmCli ? process.execPath : "npm";
      const argv = npmCli ? [npmCli, ...args] : args;
      return run(cmd, argv, { cwd: root, timeoutMs: 180000, env: npmEnv, ...o });
    },
    /** 从 git remote / package.json 推出 owner/repo（--status 也要用，所以做成懒加载）。 */
    resolveSlug() {
      if (ctx.slug) return ctx.slug;
      const r = ctx.run("git", ["remote", "get-url", "origin"], { cwd: ctx.root });
      const url = (r.stdout || "").trim();
      if (r.code === 0 && url) {
        ctx.remoteUrl = url;
        ctx.slug = parseGhSlugFromUrl(url);
      }
      if (!ctx.slug) ctx.slug = slugFromPkg(pkg);
      return ctx.slug;
    },
    /** registry 上已有的版本列表（包不存在 = ok:false + E404）。 */
    registryVersions() {
      const r = ctx.npm(["view", pkg.name, "versions", "--json"]);
      const text = (r.stdout || "").trim();
      if (text === "") return { ok: false, list: [], error: tailLines(`${r.stderr}\n${r.stdout}`, 4) || `npm view 退出码 ${r.code}` };
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        const list = (text.match(/"(\d[^"]*)"/g) || []).map((s) => s.replace(/"/g, ""));
        return list.length ? { ok: true, list } : { ok: false, list: [], error: "versions 输出无法解析" };
      }
      if (Array.isArray(j)) return { ok: true, list: j.map(String) };
      if (typeof j === "string") return { ok: true, list: [j] };
      // npm 出错时（E404 / EPERM…）会往 stdout 打 {"error":{...}} —— 别把错误对象当版本列表
      const err = j && j.error ? `${j.error.code || "ERR"}：${j.error.summary || j.error.detail || ""}` : "versions 输出结构异常";
      return { ok: false, list: [], error: tailLines(err, 3) };
    },
    /** registry 上的 dist-tags。 */
    npmDistTags() {
      const r = ctx.npm(["view", pkg.name, "dist-tags", "--json"]);
      const text = (r.stdout || "").trim();
      if (text === "") return { ok: false, tags: {}, error: tailLines(`${r.stderr}\n${r.stdout}`, 4) || `npm view 退出码 ${r.code}` };
      try {
        const j = JSON.parse(text);
        if (j && j.error) return { ok: false, tags: {}, error: `${j.error.code || "ERR"}：${j.error.summary || ""}` };
        return { ok: true, tags: j && typeof j === "object" ? j : {} };
      } catch {
        return { ok: false, tags: {}, error: "dist-tags 输出不是 JSON" };
      }
    },
    save() {
      if (!ctx.writable) return;
      try {
        writeState(ctx.root, ctx.state);
      } catch (e) {
        log(`   ⚠️ 状态文件写入失败：${e.message}`);
      }
    },
    /** --resume 时判断 pack 步的产物还能不能复用。 */
    packArtifactValid() {
      const tgz = ctx.state?.tgzPath || join(ctx.root, `${pkg.name}-${pkg.version}.tgz`);
      if (!existsSync(tgz)) return false;
      if (!ctx.state?.sha256) return false;
      try {
        return sha256(readFileSync(tgz)) === ctx.state.sha256;
      } catch {
        return false;
      }
    },
  };
  return ctx;
}

// ──────────────────────────────────────────────────────────────
// 步骤实现：每个返回 {outcome, detail, extra?, errorText?}
// outcome: OK | SKIP | FAIL | PENDING | DRY
// ──────────────────────────────────────────────────────────────

async function stepPreflight(ctx) {
  const { run, opts, root } = ctx;
  const problems = [];
  const notes = [];

  // ① git remote 必须是 SSH（本机 HTTPS git 会被间歇重置）
  const r = run("git", ["remote", "get-url", "origin"], { cwd: root });
  const remoteUrl = (r.stdout || "").trim();
  if (r.code !== 0 || remoteUrl === "") {
    problems.push(`读不到 git remote origin（退出码 ${r.code}）：${tailLines(r.stderr, 3)}`);
  } else {
    ctx.remoteUrl = remoteUrl;
    ctx.slug = parseGhSlugFromUrl(remoteUrl) || slugFromPkg(ctx.pkg);
    if (!/^(git@github\.com[:/]|ssh:\/\/git@github\.com)/.test(remoteUrl)) {
      problems.push(
        `origin 不是 SSH 形式：${remoteUrl}\n` +
          "      → 本机对 github.com 的 HTTPS git 会被间歇重置。改成 SSH 443 通道：\n" +
          "        git remote set-url origin git@github.com:<owner>/<repo>.git（详见 dev-docs/Git上传指南.md）",
      );
    } else {
      notes.push(`origin（SSH）：${remoteUrl}`);
    }
  }

  // ② 分支 / 未推送提交（verify-triple 要拿远端 tree 比对）
  const br = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
  ctx.branch = opts.branch || (br.code === 0 ? (br.stdout || "").trim() : "master");
  notes.push(`分支：${ctx.branch}`);
  const ahead = run("git", ["rev-list", "--count", `refs/remotes/origin/${ctx.branch}..HEAD`], { cwd: root });
  if (ahead.code === 0 && Number((ahead.stdout || "0").trim()) > 0) {
    notes.push(`⚠️ 有 ${(ahead.stdout || "").trim()} 个提交还没 push → verify-triple 的 git 侧会不一致（建议发布前先 git push，走 SSH）`);
  }

  // ③ gh 存在性 + 登录态
  if (!opts.skipGh) {
    const gv = run("gh", ["--version"], { cwd: root });
    if (gv.code !== 0) {
      problems.push("找不到 gh 命令（GitHub CLI）：装好后 `gh auth login`（Token 需要 repo 权限）");
    } else {
      const au = run("gh", ["auth", "status"], { cwd: root });
      if (au.code !== 0) {
        problems.push(`gh 未登录：${tailLines(`${au.stdout}\n${au.stderr}`, 4)}\n      → cd 仓库根跑 gh auth login`);
      } else {
        const who = (String(au.stdout || "").match(/account\s+(\S+)/) || [])[1];
        notes.push(`gh 已登录${who ? `（${who}）` : ""}`);
      }
    }
    if (!ctx.slug) problems.push("无法从 remote / package.json.repository 推断 owner/repo");
  }

  // ④ npm 凭据（只做 whoami；详细体检交给 npm-preflight.mjs）
  if (!opts.skipNpm) {
    const who = ctx.npm(["whoami"]);
    if (who.code !== 0) {
      problems.push(
        `npm whoami 失败：${tailLines(`${who.stdout}\n${who.stderr}`, 4)}\n` +
          "      → token 过期/被撤销（E401）就先 npm login --auth-type=web（Windows Hello），\n" +
          "        或按 dev-docs/npm发布与registry-OTP操作.md 的 webauth 流程换一枚可发布的 token",
      );
    } else {
      notes.push(`npm 身份：${(who.stdout || "").trim()}`);
    }
  }

  // ⑤ 版本 / tag 口径提醒（不阻塞）
  if (isPrerelease(ctx.version) && ctx.tag === "latest") {
    notes.push("⚠️ 预发布版本（含 -）配 --tag latest：确认这是本意（默认口径是 --tag next）");
  }
  if (!isPrerelease(ctx.version) && ctx.tag === "next") {
    notes.push(`ℹ️ 正式版本配 --tag ${ctx.tag}：npm 上 latest 不会跟着更新（需要 --tag latest --yes）`);
  }
  if (ctx.channelInfo && ctx.tag !== ctx.channelInfo.distTag) {
    notes.push(
      `⚠️ 通道 ${ctx.channelInfo.channel} 的既定 dist-tag 是 ${ctx.channelInfo.distTag}，本次用的是 ${ctx.tag} —— ` +
        `确认后再执行；照口径应当用 --channel ${ctx.channelInfo.channel}`,
    );
  }

  if (problems.length) {
    return { outcome: "FAIL", detail: `${problems.length} 项前置条件不满足`, errorText: problems.join("\n   ❌ ") };
  }
  return { outcome: "OK", detail: notes.filter((n) => n.startsWith("origin") || n.startsWith("分支")).join(" · "), notes };
}

async function stepPack(ctx) {
  const tgzName = `${ctx.pkg.name}-${ctx.pkg.version}.tgz`;
  const tgzPath = join(ctx.root, tgzName);
  const script = join(ctx.root, "tools", "dev", "pack.mjs");

  // --resume：产物还在且 sha256 与状态文件一致 → 不重复打包
  if (ctx.resume && ctx.state.steps?.pack?.status === "done" && ctx.packArtifactValid()) {
    return { outcome: "SKIP", detail: `--resume：复用已完成的 tgz（sha256 ${String(ctx.state.sha256).slice(0, 16)}…）` };
  }

  if (ctx.dry) {
    return { outcome: "DRY", detail: `将执行：node tools/dev/pack.mjs（build.mjs + npm pack）→ ${tgzName}` };
  }

  const r = ctx.run(process.execPath, [script], { cwd: ctx.root, timeoutMs: 900000 });
  if (r.code !== 0) {
    return { outcome: "FAIL", detail: `build/pack 失败（退出码 ${r.code}）`, errorText: tailLines(`${r.stdout}\n${r.stderr}`, 20) };
  }
  if (!existsSync(tgzPath)) {
    return {
      outcome: "FAIL",
      detail: `pack 退出 0 但找不到 ${tgzName}`,
      errorText: tailLines(r.stdout, 20),
    };
  }
  const buf = readFileSync(tgzPath);
  const hash = sha256(buf);
  const size = statSync(tgzPath).size;
  ctx.state.sha256 = hash;
  ctx.state.tgzPath = tgzPath;
  return { outcome: "OK", detail: `${tgzName}（${size} B，sha256 ${hash.slice(0, 16)}…）`, extra: { tgz: tgzName, size } };
}

async function stepNpm(ctx) {
  const { pkg, version, tag, opts } = ctx;

  // 幂等判断：registry 上已有同版本 → 不重复发
  const versions = ctx.registryVersions();
  if (versions.ok) {
    if (versions.list.includes(version)) {
      return { outcome: "SKIP", detail: `registry 上已存在 ${pkg.name}@${version}，不重复发布` };
    }
    const stage = versions.list.find((v) => /^0\.0\.0-stage/.test(v));
    if (stage) {
      return {
        outcome: "PENDING",
        detail:
          `registry 有 ${stage} 占位、目标版本尚未落库 → staged publishing 处理中。` +
          "不要重复 publish，等几分钟后 --apply --resume 重试（届时 npm 步会 SKIP）",
      };
    }
  } else if (!/E404|404/i.test(versions.error || "")) {
    return {
      outcome: "FAIL",
      detail: "查不到 registry 版本列表，不能盲发（网络 / 凭据问题）",
      errorText: versions.error,
    };
  }

  const script = join(ctx.root, "tools", "dev", "publish-npm.mjs");
  const args = [script, "--apply", "--tag", tag];
  if (opts.otp) args.push("--otp", opts.otp);

  if (ctx.dry) {
    return { outcome: "DRY", detail: `将执行：node tools/dev/publish-npm.mjs --apply --tag ${tag}${opts.otp ? " --otp ***" : ""}` };
  }

  const r = ctx.run(process.execPath, args, { cwd: ctx.root, timeoutMs: 1800000 });
  const blob = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) {
    let hint = "";
    if (/EOTP|one-time pass/i.test(blob)) {
      hint = "token 没有 Bypass 2FA：加 --otp <6位> 重跑，或 npm login --auth-type=web 换全权 token";
    } else if (/EPUBLISHCONFLICT|cannot publish over/i.test(blob)) {
      hint = "该版本已被发布（并发 / 重跑）：用 --apply --resume，npm 步会 SKIP";
    } else if (/E401|Unauthorized/i.test(blob)) {
      hint = "凭据无效：检查项目 .npmrc 的 _authToken";
    } else if (/EBUSY|EPERM|EACCES/i.test(blob)) {
      hint = "文件被占用 / 权限不足：关掉占用该目录的编辑器或杀毒扫描后重跑";
    }
    return { outcome: "FAIL", detail: `npm 发布失败（退出码 ${r.code}）${hint ? `：${hint}` : ""}`, errorText: tailLines(blob, 18) };
  }

  // 发布后可见性（staged publishing 对新包名要等几分钟）
  let visible = ctx.registryVersions().list.includes(version);
  let waited = 0;
  while (!visible && opts.waitMs > 0 && waited < opts.waitMs) {
    await sleep(5000);
    waited += 5000;
    visible = ctx.registryVersions().list.includes(version);
    if (!visible) ctx.log(`      … 等 registry 落库 ${Math.round(waited / 1000)}s / ${Math.round(opts.waitMs / 1000)}s`);
  }
  return {
    outcome: "OK",
    detail: visible
      ? `registry 已可见 ${pkg.name}@${version}`
      : "publish 退出 0，但 registry 暂未见该版本（staged publishing 未落库）→ 稍后 --apply --resume（只会重跑 verify）",
    extra: { registryVisible: visible },
  };
}

/** 远端 tag 指向哪个 commit（走 gh api：本机 HTTPS API 稳定，SSH git ls-remote 也可能抖动）。 */
function remoteTagCommit(ctx, tagName) {
  const ref = ctx.run("gh", ["api", `repos/${ctx.slug}/git/ref/tags/${tagName}`], { cwd: ctx.root });
  if (ref.code !== 0) {
    const blob = `${ref.stdout}\n${ref.stderr}`;
    if (/404|Not Found/i.test(blob)) return { exists: false };
    return { exists: null, error: tailLines(blob, 3) };
  }
  let obj;
  try {
    obj = JSON.parse(ref.stdout).object || {};
  } catch {
    return { exists: null, error: "gh api git/ref 返回值不是 JSON" };
  }
  if (obj.type === "tag" && obj.sha) {
    const t = ctx.run("gh", ["api", `repos/${ctx.slug}/git/tags/${obj.sha}`], { cwd: ctx.root });
    if (t.code === 0) {
      try {
        obj = JSON.parse(t.stdout).object || obj;
      } catch {
        /* 保留 tag 对象 sha */
      }
    }
  }
  return { exists: true, commit: obj.sha || null, type: obj.type || null };
}

function releaseView(ctx, tagName) {
  const r = ctx.run("gh", ["release", "view", tagName, "--json", "tagName,isPrerelease,url,assets", "-R", ctx.slug], {
    cwd: ctx.root,
  });
  if (r.code === 0) {
    try {
      return { exists: true, info: JSON.parse(r.stdout) };
    } catch {
      return { exists: null, error: "gh release view 返回值不是 JSON" };
    }
  }
  const blob = `${r.stdout}\n${r.stderr}`;
  if (/release not found|not found|404/i.test(blob)) return { exists: false };
  return { exists: null, error: tailLines(blob, 4) };
}

function buildReleaseNotes(ctx, tgzName, localHash) {
  return [
    `双平台同步发布 ${ctx.pkg.name}@${ctx.version}`,
    "",
    `- npm：https://www.npmjs.com/package/${ctx.pkg.name}/v/${ctx.version}（dist-tag：${ctx.tag}）`,
    `- 资产：${tgzName}`,
    `- sha256：${localHash}`,
    "",
    "（由 tools/dev/publish-all.mjs 生成；发布说明文件缺失时的兜底正文）",
  ].join("\n");
}

async function stepGh(ctx) {
  const { version, opts } = ctx;
  ensureBranch(ctx); // --resume 跳过 preflight 时 ctx.branch 会是 null（见 ensureBranch 注释）
  const slug = ctx.resolveSlug();
  if (!slug) return { outcome: "FAIL", detail: "无法确定 owner/repo（git remote / package.json.repository）" };
  const tagName = `v${version}`;
  const tgzName = `${ctx.pkg.name}-${version}.tgz`;
  const tgzPath = ctx.state.tgzPath || join(ctx.root, tgzName);

  if (!ctx.dry && !existsSync(tgzPath)) {
    return { outcome: "FAIL", detail: `找不到 ${tgzName}（${tgzPath}）→ 先跑通 pack 步` };
  }
  const localHash = ctx.state.sha256 || (existsSync(tgzPath) ? sha256(readFileSync(tgzPath)) : null);
  const localSize = existsSync(tgzPath) ? statSync(tgzPath).size : null;

  // ── ① Release 已存在？
  const view = releaseView(ctx, tagName);
  if (view.exists === null) {
    return { outcome: "FAIL", detail: `查 Release 失败（网络 / 权限）→ 可重跑`, errorText: view.error };
  }

  if (view.exists) {
    const assets = view.info.assets || [];
    const asset = assets.find((a) => a.name === tgzName);
    if (!asset) {
      if (ctx.dry) return { outcome: "DRY", detail: `Release ${tagName} 已存在但缺 ${tgzName} → 将执行 gh release upload` };
      const up = ctx.run("gh", ["release", "upload", tagName, tgzPath, "-R", slug], { cwd: ctx.root, timeoutMs: 600000 });
      if (up.code !== 0) {
        return { outcome: "FAIL", detail: `补传资产失败（退出码 ${up.code}）→ 可重跑`, errorText: tailLines(`${up.stdout}\n${up.stderr}`, 12) };
      }
      return { outcome: "OK", detail: `Release ${tagName} 已存在，补传缺失资产 ${tgzName}` };
    }
    // 资产存在 → 严格比对 sha256（一致才跳过；不一致明确报错，绝不覆盖）
    const remoteHash = assetSha256(asset);
    if (!remoteHash) {
      if (asset.size && localSize && asset.size !== localSize) {
        return {
          outcome: "FAIL",
          detail: `资产 ${tgzName} 已存在但大小不一致（本地 ${localSize} B / 远端 ${asset.size} B），且远端没给 sha256 → 不覆盖，请人工决定`,
        };
      }
      return { outcome: "SKIP", detail: `资产已存在，远端未提供 sha256，仅大小一致（${asset.size ?? "?"} B）→ 人工复核后决定是否重传` };
    }
    if (localHash && remoteHash !== localHash) {
      return {
        outcome: "FAIL",
        detail:
          `资产 ${tgzName} 已存在但 sha256 不一致（本地 ${localHash.slice(0, 16)}… / 远端 ${remoteHash.slice(0, 16)}…）→ **不自动覆盖**。` +
          `人工决定：gh release delete-asset ${tagName} ${tgzName} 后 --apply --resume，或换版本号`,
        errorText: `local  = ${localHash}\nremote = ${remoteHash}`,
      };
    }
    return { outcome: "SKIP", detail: `Release ${tagName} 与资产 sha256 均一致（${remoteHash.slice(0, 16)}…）` };
  }

  // ── ② Release 不存在：先确认 tag 状态（已存在只能内容一致才复用）
  const tagState = ctx.dry ? { exists: false, commit: null } : remoteTagCommit(ctx, tagName);
  if (tagState.exists === null) {
    return { outcome: "FAIL", detail: "查远端 tag 失败（网络 / 权限）→ 可重跑", errorText: tagState.error };
  }
  if (tagState.exists) {
    const head = ctx.run("git", ["rev-parse", "HEAD"], { cwd: ctx.root });
    const headSha = head.code === 0 ? (head.stdout || "").trim() : null;
    if (!headSha || (tagState.commit && tagState.commit !== headSha)) {
      return {
        outcome: "FAIL",
        detail:
          `tag ${tagName} 已存在于远端但指向 ${String(tagState.commit).slice(0, 12)}…，本地 HEAD 是 ${String(headSha).slice(0, 12)}… → ` +
          "内容不一致，脚本不覆盖。人工决定：git tag -d / git push origin :refs/tags/… 删掉重打，或换版本号",
        errorText: `remote tag → ${tagState.commit}\nlocal HEAD → ${headSha}`,
      };
    }
  }

  const notesFile = join(ctx.root, "docs", "releases", `${version}.md`);
  const hasNotes = existsSync(notesFile);
  const prerelease = isPrerelease(version);
  // Release 标题：网页主线保持「就是版本号」（历史一致）；其它通道加前缀，让人一眼看出这是给哪个端的。
  const releaseTitle = ctx.channelInfo && ctx.channelInfo.channel !== "web" ? `[${ctx.channelInfo.releaseLabel}] ${version}` : version;
  // ⚠️ `--target` 只在**本次新建 tag** 时给：tag 已存在时再传 target_commitish，GitHub 会回
  // 「422 Validation Failed: Release.target_commitish is invalid」（2026-11-27 实测，1.0.4 那次也踩过）。
  // 幂等重跑（tag 已推、只补 Release）时直接省略 --target，让 Release 跟着已存在的 tag 走。
  const createArgs = ["release", "create", tagName, `${tgzPath}#${tgzName} (SHA256 ${String(localHash || "").toUpperCase()})`];
  if (!tagState.exists) createArgs.push("--target", ctx.branch);
  createArgs.push("--title", releaseTitle, "-R", slug);
  if (hasNotes) createArgs.push("--notes-file", notesFile);
  else createArgs.push("--notes", buildReleaseNotes(ctx, tgzName, localHash));
  if (prerelease) createArgs.push("--prerelease", "--latest=false");

  const plan = [];
  if (!tagState.exists) {
    plan.push(`git tag -a ${tagName} -m "release ${tagName}"`);
    plan.push(`git push origin ${tagName}`);
  }
  plan.push(`gh release create ${tagName} ${tgzName}${tagState.exists ? "" : ` --target ${ctx.branch}`}${hasNotes ? " --notes-file docs/releases/" + version + ".md" : " --notes <生成>"}${prerelease ? " --prerelease --latest=false" : ""}`);

  if (ctx.dry) {
    return { outcome: "DRY", detail: `将执行：${plan.join("；然后 ")}` };
  }

  // ── ③ 打 tag 并 push（SSH 443；失败可原地重跑）
  if (!tagState.exists) {
    const localTag = ctx.run("git", ["rev-parse", "--verify", `refs/tags/${tagName}`], { cwd: ctx.root });
    if (localTag.code !== 0) {
      const mk = ctx.run("git", ["tag", "-a", tagName, "-m", `release ${tagName}`], { cwd: ctx.root });
      if (mk.code !== 0) {
        return { outcome: "FAIL", detail: `打 tag 失败（退出码 ${mk.code}）`, errorText: tailLines(`${mk.stdout}\n${mk.stderr}`, 10) };
      }
    }
    const push = ctx.run("git", ["push", "origin", tagName], { cwd: ctx.root, timeoutMs: 180000 });
    if (push.code !== 0) {
      return {
        outcome: "FAIL",
        detail: `push tag 失败（退出码 ${push.code}）→ 本机 HTTPS git 会被重置，确认 origin 是 SSH（dev-docs/Git上传指南.md），重跑 --apply --resume`,
        errorText: tailLines(`${push.stdout}\n${push.stderr}`, 12),
      };
    }
  }

  // ── ④ 建 Release + 上传资产
  const cr = ctx.run("gh", createArgs, { cwd: ctx.root, timeoutMs: 600000 });
  if (cr.code !== 0) {
    return {
      outcome: "FAIL",
      detail: `gh release create 失败（退出码 ${cr.code}）→ 可重跑（release 若已建好，重跑会走"只补资产"）`,
      errorText: tailLines(`${cr.stdout}\n${cr.stderr}`, 14),
    };
  }
  return {
    outcome: "OK",
    detail: `已建 Release ${tagName}${prerelease ? "（pre-release）" : ""} 并上传 ${tgzName}`,
    extra: { releaseUrl: (() => { try { return JSON.parse(cr.stdout).url; } catch { return null; } })() },
  };
}

/**
 * 确保 `ctx.branch` 有值。
 * 坑（2026-11-27 实测）：分支只在 **preflight** 步骤里解析，而 `--resume` 会跳过 preflight →
 * `ctx.branch` 保持 null → `verify-triple --ref null` → gh 404 → verify 永远失败。
 * 任何用到分支的步骤（gh / verify）都必须自己先确保它。
 */
function ensureBranch(ctx) {
  if (typeof ctx.branch === "string" && ctx.branch.trim() !== "") return ctx.branch;
  const br = ctx.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.root });
  ctx.branch = br.code === 0 && String(br.stdout || "").trim() !== "" ? String(br.stdout).trim() : "master";
  return ctx.branch;
}

async function stepVerify(ctx) {
  const { version, tag, opts } = ctx;
  ctx.resolveSlug();
  const tagName = `v${version}`;
  const problems = [];
  const notes = [];

  // dry-run：只报"现状 + 将执行什么"，不把"还没发布"当成校验失败
  if (ctx.dry) {
    const dt = opts.skipNpm ? null : ctx.npmDistTags();
    if (dt) notes.push(dt.ok ? `现状 dist-tags：${Object.entries(dt.tags).map(([k, v]) => `${k}=${v}`).join(", ") || "（空）"}` : `现状 dist-tags：读取失败（${dt.error}）`);
    const rv = ctx.slug ? releaseView(ctx, tagName) : { exists: null };
    notes.push(rv.exists ? `现状：${tagName} 的 Release 已存在` : `现状：${tagName} 的 Release 还不存在（本次将创建）`);
    if (!opts.skipNpm) notes.push(`将执行：node tools/dev/verify-triple.mjs --ref ${ctx.branch}`);
    return { outcome: "DRY", detail: `将核对 dist-tags.${tag} = ${version}、Release 资产 sha256、verify-triple 三方一致`, notes };
  }

  // ① dist-tags 口径（rc 绝不能占 latest）
  if (!opts.skipNpm) {
    const dt = ctx.npmDistTags();
    if (!dt.ok) {
      problems.push(`读不到 npm dist-tags：${dt.error}`);
    } else {
      notes.push(`dist-tags：${Object.entries(dt.tags).map(([k, v]) => `${k}=${v}`).join(", ") || "（空）"}`);
      if (dt.tags[tag] !== version) {
        problems.push(`dist-tags.${tag} = ${dt.tags[tag] ?? "（缺失）"}，期望 ${version}（staged publishing 可能还没生效 → 等几分钟再 --apply --resume）`);
      }
      if (tag !== "latest" && dt.tags.latest === version) {
        problems.push(`🚨 dist-tags.latest 指向了 ${version}，而本次用的是 --tag ${tag} → 预发版抢了 latest，去 npm 页面改回`);
      }
    }
  }

  // ② GitHub 侧：Release 存在 + 资产 sha256 + pre-release 标记
  const view = releaseView(ctx, tagName);
  if (view.exists === null) {
    problems.push(`查 Release 失败：${view.error}`);
  } else if (!view.exists) {
    problems.push(`${tagName} 的 Release 不存在`);
  } else {
    const asset = (view.info.assets || []).find((a) => a.name === `${ctx.pkg.name}-${version}.tgz`);
    if (!asset) problems.push(`Release ${tagName} 缺少资产 ${ctx.pkg.name}-${version}.tgz`);
    else {
      const rh = assetSha256(asset);
      if (rh && ctx.state.sha256 && rh !== ctx.state.sha256) {
        problems.push(`资产 sha256 与本地 tgz 不一致（远端 ${rh.slice(0, 16)}… / 本地 ${ctx.state.sha256.slice(0, 16)}…）`);
      } else notes.push(`资产 sha256 ${rh ? rh.slice(0, 16) + "…" : "（远端未提供）"}`);
    }
    if (isPrerelease(version) && !view.info.isPrerelease) problems.push(`Release ${tagName} 没标 pre-release（rc 版应标 --prerelease）`);
  }

  // ③ verify-triple：git 远端 ↔ npm 线上 ↔ 本地 逐文件 sha256
  const script = join(ctx.root, "tools", "dev", "verify-triple.mjs");
  if (opts.skipNpm) {
    notes.push("verify-triple 跳过：npm 侧未发布，没有可比对的线上 tgz");
  } else {
    ensureBranch(ctx);
    const vt = ctx.run(process.execPath, [script, "--ref", ctx.branch], { cwd: ctx.root, timeoutMs: 900000 });
    // 把实际用的 ref 打印出来：ref 写错时报的是「gh 404」，看不出是 ref 的问题（2026-11-27 实测）
    console.log(`        verify-triple --ref ${JSON.stringify(ctx.branch)}（退出码 ${vt.code}）`);
    const out = `${vt.stdout}\n${vt.stderr}`;
    const conclusion = (out.split("\n").find((l) => l.includes("结论：")) || "").trim();
    if (vt.code !== 0 || !conclusion) {
      // 把子进程的真实输出尾巴带出来：否则只看到"异常退出（1）"根本没法定位（2026-11-27 实测踩到）
      const tail = out.split("\n").filter(Boolean).slice(-8).join("\n        ");
      problems.push(`verify-triple 异常退出（${vt.code}）${conclusion ? `：${conclusion}` : ""}${tail ? `\n        子进程输出尾部：${tail}` : ""}`);
    } else if (!conclusion.includes("✅")) {
      problems.push(`verify-triple 结论不一致：${conclusion}`);
    } else {
      notes.push(conclusion);
    }
  }

  if (problems.length) return { outcome: "FAIL", detail: `${problems.length} 项校验未通过`, errorText: problems.join("\n   ❌ "), notes };
  return { outcome: "OK", detail: notes.filter((n) => n.startsWith("dist-tags") || n.startsWith("资产") || n.startsWith("结论")).join(" · "), notes };
}

// ──────────────────────────────────────────────────────────────
// 下载量统计（npm 包级 + GitHub 版本级）
// ──────────────────────────────────────────────────────────────

async function npmDownloadPoint(ctx, period) {
  const url = `${NPM_DL_API}/${period}/${encodeURIComponent(ctx.pkg.name)}`;
  try {
    const j = await ctx.httpsGetJson(url);
    if (typeof j?.downloads !== "number") return { available: false, error: "响应里没有 downloads 字段" };
    return { available: true, downloads: j.downloads, start: j.start, end: j.end };
  } catch (e) {
    return { available: false, error: e?.message || String(e) };
  }
}

function ghDownloadTotals(ctx) {
  if (!ctx.slug) return { available: false, error: "未确定 owner/repo" };
  const r = ctx.run("gh", ["api", "--paginate", "--slurp", `repos/${ctx.slug}/releases?per_page=100`], {
    cwd: ctx.root,
    timeoutMs: 180000,
  });
  if (r.code !== 0) return { available: false, error: tailLines(`${r.stdout}\n${r.stderr}`, 3) };
  let pages;
  try {
    pages = JSON.parse(r.stdout);
  } catch {
    return { available: false, error: "releases 列表不是 JSON" };
  }
  const releases = (Array.isArray(pages) ? pages.flat(1) : []).map((rel) => ({
    tag: rel.tag_name,
    prerelease: !!rel.prerelease,
    downloads: (rel.assets || []).reduce((s, a) => s + (a.download_count || 0), 0),
    assets: (rel.assets || []).map((a) => ({ name: a.name, downloads: a.download_count || 0, size: a.size, digest: a.digest || null })),
  }));
  return { available: true, total: releases.reduce((s, x) => s + x.downloads, 0), releases };
}

function ghTagDownloads(ctx, tagName) {
  if (!ctx.slug) return null;
  const r = ctx.run("gh", ["api", `repos/${ctx.slug}/releases/tags/${tagName}`], { cwd: ctx.root });
  if (r.code !== 0) return null;
  try {
    const rel = JSON.parse(r.stdout);
    return {
      tag: rel.tag_name,
      prerelease: !!rel.prerelease,
      downloads: (rel.assets || []).reduce((s, a) => s + (a.download_count || 0), 0),
      assets: (rel.assets || []).map((a) => ({ name: a.name, downloads: a.download_count || 0 })),
    };
  } catch {
    return null;
  }
}

async function collectDownloads(ctx) {
  const [week, month] = await Promise.all([npmDownloadPoint(ctx, "last-week"), npmDownloadPoint(ctx, "last-month")]);
  const github = ghDownloadTotals(ctx);
  const currentTag = ghTagDownloads(ctx, `v${ctx.version}`);
  return { fetchedAt: nowIso(), npm: { week, month }, github: { ...github, currentTag } };
}

function printDownloads(ctx, dl) {
  const rows = [
    ["npm", "last-week（包级）", dl.npm.week.available ? fmtNum(dl.npm.week.downloads) : "unavailable"],
    ["npm", "last-month（包级）", dl.npm.month.available ? fmtNum(dl.npm.month.downloads) : "unavailable"],
    ["GitHub", "全部 Release 资产累计", dl.github.available ? fmtNum(dl.github.total) : "unavailable"],
  ];
  if (dl.github.currentTag) rows.push(["GitHub", `${dl.github.currentTag.tag} 单版本资产`, fmtNum(dl.github.currentTag.downloads)]);

  ctx.log("\n📊 下载量对比（两列口径不同，别当成同一件事）");
  const head = ["平台", "指标", "数值"];
  const widths = [8, 28, 12];
  // 中文字符占 2 个显示列 → 按显示宽度补齐，表格才不会歪
  const padW = (s, w) => {
    const str = String(s);
    const used = [...str].reduce((n, c) => n + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
    return str + " ".repeat(Math.max(0, w - used));
  };
  const line = (cells) => cells.map((c, i) => padW(c, widths[i])).join(" ");
  ctx.log(`  ${line(head)}`);
  ctx.log(`  ${"-".repeat(widths.reduce((a, b) => a + b + 1, 0))}`);
  for (const r of rows) ctx.log(`  ${line(r)}`);
  ctx.log("  口径：npm = **包级**（dsh-drydock 全部版本合计，按周/月窗口滚动）");
  ctx.log("        GitHub = **版本级累计**（每个 Release 的 asset download_count 求和，全历史）");
  ctx.log("        → npm 的周下载 ≠ GitHub 某版本累计，两者不可相加/不可直接比较；看趋势即可。");
  if (!dl.npm.week.available && dl.npm.week.error) ctx.log(`  npm 统计不可用：${dl.npm.week.error}`);
  if (!dl.github.available && dl.github.error) ctx.log(`  GitHub 统计不可用：${dl.github.error}`);
}

// ──────────────────────────────────────────────────────────────
// --status
// ──────────────────────────────────────────────────────────────

function printHelp(log) {
  const lines = [
    "tools/dev/publish-all.mjs — npm + GitHub 双平台发布（幂等 / 可重入 / 默认 dry-run）",
    "",
    "用法：",
    "  node tools/dev/publish-all.mjs --status               只查状态（两边版本 / dist-tags / 下载量），零写入",
    "  node tools/dev/publish-all.mjs                        dry-run：打印每一步将要做什么",
    "  node tools/dev/publish-all.mjs --apply                真发布（默认 --tag next）",
    "  node tools/dev/publish-all.mjs --apply --tag latest --yes   覆盖 latest（必须 --yes 二次确认）",
    "  node tools/dev/publish-all.mjs --apply --skip-npm     只补 GitHub 侧（用本地 tgz 建 Release / 补资产）",
    "  node tools/dev/publish-all.mjs --apply --skip-gh      只补 npm 侧",
    "  node tools/dev/publish-all.mjs --resume               断点续传（dry-run：只看会补哪几步）",
    "  node tools/dev/publish-all.mjs --apply --resume       断点续传（真执行，只补没做成的步骤）",
    "",
    "其它参数：",
    "  --channel <名>    发布通道（web|desktop|community）：必须与版本号推断一致，并把 dist-tag 对齐到该通道",
    "  --otp <6位>       npm token 没有 Bypass 2FA 时用",
    "  --wait <秒>       发布后轮询 registry，等 staged publishing 落库（默认 0）",
    "  --branch <名>     gh release --target / verify-triple --ref 用的分支（默认当前分支）",
    "  --cache <目录>    npm 缓存目录（默认仓库内 .npm-cache/；沙箱里用户级缓存不可写）",
    "  --json            --status 输出机器可读 JSON",
    "  --help / -h       本帮助",
    "",
    "状态文件：<仓库根>/.publish-state.json（已 .gitignore；原子写：tmp + rename）",
    "退出码：0 = 全部 OK/SKIP；1 = 有 FAIL/PENDING；2 = 用法错误",
    "",
    "文档：E:\\harness\\dev-docs\\双平台发布与自动同步.md",
  ];
  for (const l of lines) log(l);
}

async function printStatus(ctx) {
  const { pkg, version, tag, log } = ctx;
  const slug = ctx.resolveSlug();
  const versions = ctx.registryVersions();
  const dt = ctx.npmDistTags();
  const state = readState(ctx.root);

  const ghLatest = slug
    ? ctx.run("gh", ["release", "list", "--limit", "5", "--json", "tagName,isLatest,isPrerelease", "-R", slug], { cwd: ctx.root })
    : { code: 1, stdout: "" };
  let latestRelease = null;
  if (ghLatest.code === 0) {
    try {
      const arr = JSON.parse(ghLatest.stdout);
      latestRelease = arr.find((x) => x.isLatest) || arr[0] || null;
    } catch {
      latestRelease = null;
    }
  }
  const curRel = slug ? releaseView(ctx, `v${version}`) : { exists: null, error: "未确定 owner/repo" };
  const dl = await collectDownloads(ctx);

  if (ctx.opts.json) {
    const out = {
      package: pkg.name,
      version,
      tag,
      slug,
      npm: { versions: versions.ok ? versions.list : null, versionsError: versions.ok ? null : versions.error, distTags: dt.ok ? dt.tags : null },
      github: { latest: latestRelease, current: curRel.exists ? curRel.info : null, currentError: curRel.exists === null ? curRel.error : null },
      state,
      downloads: dl,
    };
    log(JSON.stringify(out, null, 1));
    return 0;
  }

  log(`📦 ${pkg.name}@${version} 状态（只读查询，零写入）`);
  log(`   仓库：${ctx.root}`);
  log(`   dist-tag 目标：${tag}`);
  log("");
  log("npm registry");
  if (dt.ok) log(`  dist-tags     : ${Object.entries(dt.tags).map(([k, v]) => `${k}=${v}`).join(", ") || "（空）"}`);
  else log(`  dist-tags     : 读取失败（${dt.error}）`);
  if (versions.ok) {
    const has = versions.list.includes(version);
    log(`  已有版本      : ${versions.list.length ? versions.list.join(", ") : "（无）"}`);
    log(`  当前版本      : ${has ? `✅ 已发布 ${version}` : `❌ 未发布（${version} 不在 registry）`}`);
  } else {
    log(`  已有版本      : 读取失败（${versions.error}）`);
  }
  log("");
  log("GitHub");
  log(`  slug          : ${ctx.slug || "（未确定：先检查 git remote）"}`);
  if (latestRelease) log(`  最新 Release  : ${latestRelease.tagName}${latestRelease.isPrerelease ? "（pre-release）" : ""}${latestRelease.isLatest ? "（latest）" : ""}`);
  if (curRel.exists === null) log(`  当前版本      : 查询失败（${curRel.error}）`);
  else if (curRel.exists) {
    const asset = (curRel.info.assets || []).find((a) => a.name === `${pkg.name}-${version}.tgz`);
    log(`  当前版本      : ✅ v${version} 已存在${asset ? `（资产 ${asset.name} / ${asset.size} B）` : "（⚠️ 缺 tgz 资产）"}`);
  } else log(`  当前版本      : ❌ 未创建（v${version} 没有 Release）`);
  log("");
  if (state) {
    log(`本地状态文件 .publish-state.json`);
    log(`  版本 / tag    : ${state.version} / ${state.tag}`);
    log(`  步骤          : ${Object.entries(state.steps || {}).map(([k, v]) => `${k}=${v.status}`).join(" ") || "（无）"}`);
    log(`  sha256        : ${state.sha256 ? state.sha256.slice(0, 16) + "…" : "（无）"}`);
    if (state.lastError) log(`  最后错误      : [${state.lastError.step}] ${String(state.lastError.detail).split("\n")[0]}`);
    log(`  起止          : ${state.startedAt} → ${state.finishedAt || "（未完成）"}`);
  } else {
    log("本地状态文件 .publish-state.json：不存在（还没跑过 --apply）");
  }

  printDownloads(ctx, dl);
  return 0;
}

// ──────────────────────────────────────────────────────────────
// 主流程
// ──────────────────────────────────────────────────────────────

function logStepLine(ctx, index, name, outcome, detail) {
  const suffix = detail ? `（${detail}）` : "";
  ctx.log(`[${index + 1}/${STEPS.length}] ${name} ⇒ ${outcome}${suffix}`);
}

function finishStep(ctx, index, name, result) {
  const outcome = result.outcome;
  const status = outcome === "OK" || outcome === "SKIP" ? "done" : outcome === "FAIL" ? "failed" : outcome === "PENDING" ? "pending" : "planned";
  if (ctx.writable) {
    ctx.state.steps[name] = { status, outcome, at: nowIso(), detail: result.detail || "", ...(result.extra || {}) };
    if (outcome === "FAIL" || outcome === "PENDING") {
      ctx.state.lastError = { step: name, detail: result.detail || "", errorText: result.errorText || "", at: nowIso() };
    } else if (outcome === "OK") {
      ctx.state.lastError = null;
    }
  }
  ctx.save();
  logStepLine(ctx, index, name, outcome, result.detail);
  if (result.errorText && outcome !== "OK") {
    for (const line of String(result.errorText).split("\n")) ctx.log(`        ${line}`);
  }
  if (Array.isArray(result.notes)) for (const n of result.notes) ctx.log(`        · ${n}`);
  return { step: name, outcome, detail: result.detail || "" };
}

function printSummary(ctx, results, dl) {
  const { log } = ctx;
  log("\n汇总");
  const widths = [12, 8, 0];
  const line = (cells) => `${String(cells[0]).padEnd(widths[0])} ${String(cells[1]).padEnd(widths[1])} ${cells[2]}`;
  log(`  ${line(["步骤", "结果", "说明"])}`);
  log(`  ${"-".repeat(76)}`);
  for (const r of results) log(`  ${line([r.step, r.outcome, String(r.detail || "").split("\n")[0].slice(0, 96)])}`);
  if (ctx.state) {
    log("");
    log(`  版本 / tag ：${ctx.state.version} / ${ctx.state.tag}`);
    log(`  tgz        ：${ctx.state.tgzPath ? basename(ctx.state.tgzPath) : "（未产出）"}`);
    log(`  sha256     ：${ctx.state.sha256 || "（无）"}`);
    log(`  状态文件   ：${ctx.writable ? statePath(ctx.root) : "（dry-run：不写状态文件）"}`);
  }
  if (dl) printDownloads(ctx, dl);
}

export async function main(argv = [], deps = {}) {
  const opts = parseArgs(argv);
  const log = deps.log || ((line = "") => process.stdout.write(`${line}\n`));
  if (opts.help) {
    printHelp(log);
    return 0;
  }

  const root = resolve(deps.root || PKG_ROOT);
  let pkg;
  try {
    pkg = deps.pkg || JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (e) {
    log(`✘ 读不到 ${join(root, "package.json")}：${e.message}`);
    return 1;
  }

  // ── 发布通道（唯一事实来源：release/channels.json）────────
  // 版本号里的预发布标识决定通道；`--channel` 只能"确认"，不能"改写"通道（发错 dist-tag 是不可逆事故）。
  // 找不到配置时（旧仓库 / 隔离测试的临时目录）降级：跳过通道校验，不阻塞旧的 --tag 用法。
  const channelsFile = join(root, "release", "channels.json");
  let channelInfo = null;
  if (existsSync(channelsFile)) {
    try {
      channelInfo = resolveVersion(pkg.version, loadChannels(channelsFile));
    } catch (error) {
      log(`✘ 通道解析失败：${error instanceof Error ? error.message : String(error)}`);
      log("   修法：release/channels.json 里补一条通道，或把版本号改成已登记的形态（见 docs/版本与轨道.md）");
      return 2;
    }
    if (!channelInfo.enabled) {
      log(`✘ 版本 ${pkg.version} 属于通道 ${channelInfo.channel}，但该通道当前被禁用（release/channels.json enabled=false）`);
      return 2;
    }
  } else if (opts.channel !== null) {
    log(`✘ 给了 --channel ${opts.channel}，但找不到 ${channelsFile}`);
    return 2;
  }
  if (channelInfo !== null && opts.channel !== null) {
    if (opts.channel !== channelInfo.channel) {
      log(`✘ --channel ${opts.channel} 与版本号推断出的通道 ${channelInfo.channel} 不一致（${pkg.version}）`);
      log("   通道由版本号决定，不能用命令行覆盖：要发桌面通道就发 1.1.0-desktop.N 这样的版本号。");
      return 2;
    }
    if (argv.includes("--tag") && opts.tag !== channelInfo.distTag) {
      log(`✘ --channel ${opts.channel} 要求 dist-tag = ${channelInfo.distTag}，但显式给了 --tag ${opts.tag}`);
      return 2;
    }
    opts.tag = channelInfo.distTag;
  }

  const ctx = buildContext(opts, deps, pkg, root);
  ctx.channelInfo = channelInfo;

  if (opts.status) return printStatus(ctx);

  // ── 用法门禁 ────────────────────────────────────────────
  if (opts.skipNpm && opts.skipGh) {
    log("✘ --skip-npm 与 --skip-gh 同时给：两边都跳过就没有可做的事了");
    return 2;
  }
  if (opts.tag === "latest" && !opts.yes) {
    log("✘ 拒绝执行：--tag latest 会把这版推到 npm 的 latest 通道（rc 版绝不该覆盖 latest）。");
    log("   确认要覆盖 latest 时显式加 --yes：node tools/dev/publish-all.mjs --apply --tag latest --yes");
    return 2;
  }
  if (isPrerelease(pkg.version) && opts.tag === "latest") {
    log("⚠️  当前版本是预发布版（含 -），却要发到 latest 通道：请确认这是本意");
  }

  // ── 头部 ────────────────────────────────────────────────
  log(`📦 ${pkg.name}@${pkg.version}  →  npm + GitHub 双平台（dist-tag：${opts.tag}）`);
  log(`   通道：${channelInfo ? `${channelInfo.channel}（${channelInfo.releaseLabel}）· 配置既定 dist-tag = ${channelInfo.distTag}` : "未配置（缺 release/channels.json，按旧口径只认 --tag）"}`);
  if (channelInfo && opts.tag !== channelInfo.distTag) {
    log(`   ⚠️ 本次 --tag ${opts.tag} 与通道既定 dist-tag ${channelInfo.distTag} 不一致 —— 确认这是本意（否则去掉 --tag，改用 --channel ${channelInfo.channel}）`);
  }
  log(`   模式：${opts.apply ? "🚀 真执行（--apply）" : "🧪 预演（dry-run：不写 registry / 不建 release / 不写状态文件）"}${opts.resume ? " · --resume 断点续传" : ""}`);
  log(`   仓库：${root}`);
  if (opts.skipNpm) log("   --skip-npm：只补 GitHub 侧");
  if (opts.skipGh) log("   --skip-gh：只补 npm 侧");

  // ── 状态初始化 ──────────────────────────────────────────
  let prev = opts.resume ? readState(root) : null;
  if (opts.resume && !prev) log("   ⚠️ --resume：没有找到状态文件，将从头开始");
  if (prev && prev.version !== pkg.version) {
    log(`   ⚠️ --resume：状态文件记录的是 ${prev.version}，当前是 ${pkg.version} → 旧状态作废，从头开始`);
    prev = null;
  }
  ctx.state = {
    version: pkg.version,
    tag: opts.tag,
    channel: channelInfo ? channelInfo.channel : null,
    steps: prev?.steps || {},
    sha256: prev?.sha256 || null,
    tgzPath: prev?.tgzPath || null,
    startedAt: prev?.startedAt || nowIso(),
    finishedAt: null,
    lastError: prev?.lastError || null,
    downloads: prev?.downloads || null,
  };
  if (prev) {
    const done = Object.entries(prev.steps || {}).filter(([, v]) => v.status === "done").map(([k]) => k);
    if (done.length) log(`   --resume：已完成 [${done.join(", ")}]，其余重跑`);
  }

  // ── 逐步执行 ────────────────────────────────────────────
  const results = [];
  const impl = { preflight: stepPreflight, pack: stepPack, npm: stepNpm, gh: stepGh, verify: stepVerify };

  for (let i = 0; i < STEPS.length; i++) {
    const name = STEPS[i];
    const label = `${i + 1}/${STEPS.length}`;

    // 用户显式跳过（不落状态：下次不带 --skip-* 仍会尝试）
    if (name === "npm" && opts.skipNpm) {
      logStepLine(ctx, i, name, "SKIP", "--skip-npm：只补 GitHub 侧");
      results.push({ step: name, outcome: "SKIP", detail: "--skip-npm" });
      continue;
    }
    if (name === "gh" && opts.skipGh) {
      logStepLine(ctx, i, name, "SKIP", "--skip-gh：只补 npm 侧");
      results.push({ step: name, outcome: "SKIP", detail: "--skip-gh" });
      continue;
    }

    // --resume：已完成且产物可复用 → 直接跳过（不改动原时间戳）
    if (ctx.resume && ctx.state.steps?.[name]?.status === "done") {
      const reusable = name === "pack" ? ctx.packArtifactValid() : true;
      if (reusable) {
        const d = `--resume：该步已完成（${ctx.state.steps[name].at || ""}）`;
        logStepLine(ctx, i, name, "SKIP", d);
        results.push({ step: name, outcome: "SKIP", detail: d });
        continue;
      }
      log(`   --resume：pack 的产物已失效（tgz 缺失或 sha256 变了）→ 重新打包`);
    }

    log(`\n[${label}] ${name}`);
    let result;
    try {
      result = await impl[name](ctx);
    } catch (e) {
      result = { outcome: "FAIL", detail: `${name} 步抛异常：${e?.message || e}`, errorText: tailLines(e?.stack || "", 12) };
    }
    const rec = finishStep(ctx, i, name, result);
    results.push(rec);

    // 失败 / 待重试：保留已完成步骤，停止后续（避免在坏状态下继续远端写入）
    if (result.outcome === "FAIL" || result.outcome === "PENDING") {
      if (!ctx.dry) {
        for (let j = i + 1; j < STEPS.length; j++) {
          log(`[${j + 1}/${STEPS.length}] ${STEPS[j]} ⇒ SKIP（上一步未通过，未执行）`);
          results.push({ step: STEPS[j], outcome: "SKIP", detail: "上一步未通过" });
        }
        break;
      }
      log(`   （dry-run 继续打印后续步骤；真执行到这一步会中止并保留已完成步骤）`);
    }
  }

  // ── 统计 + 收尾 ─────────────────────────────────────────
  let dl = null;
  try {
    dl = await collectDownloads(ctx);
    if (ctx.writable) {
      ctx.state.downloads = dl;
      ctx.save();
    }
  } catch (e) {
    log(`   ⚠️ 下载量统计失败（不影响发布结论）：${e?.message || e}`);
    dl = null;
  }

  const failed = results.filter((r) => r.outcome === "FAIL" || r.outcome === "PENDING");
  if (ctx.writable) {
    ctx.state.finishedAt = nowIso();
    if (failed.length === 0) ctx.state.lastError = null;
    ctx.save();
  }
  printSummary(ctx, results, dl);

  if (failed.length) {
    log(`\n✘ 有 ${failed.length} 步未通过：${failed.map((r) => `${r.step}(${r.outcome})`).join(", ")}`);
    if (ctx.writable) log(`  状态已保存，修好后原地重跑：node tools/dev/publish-all.mjs --apply --resume`);
    else log(`  这是预演；确认无误后加 --apply 真执行`);
    return 1;
  }
  if (ctx.dry) {
    log("\n✅ 预演通过（没有写 registry / 没有建 release / 没有写状态文件）。真执行：node tools/dev/publish-all.mjs --apply");
    return 0;
  }
  log(`\n✅ 双平台发布链路完成：npm ${pkg.name}@${pkg.version}（tag: ${opts.tag}） + GitHub Release v${pkg.version}`);
  return 0;
}

// ──────────────────────────────────────────────────────────────
// CLI 入口（被 import 时不执行；靠 pathToFileURL 兼容中文路径）
// ──────────────────────────────────────────────────────────────
const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url || resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      process.stderr.write(`publish-all 崩溃：${(e && e.stack) || e}\n`);
      process.exitCode = 1;
    });
}
