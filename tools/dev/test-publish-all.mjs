#!/usr/bin/env node
/**
 * tools/dev/test-publish-all.mjs — tools/dev/publish-all.mjs 的行为测试
 *
 * 原则：
 *   · **绝不真发布**：不调真 npm / 真 gh / 真网络；所有外部命令由注入的假执行器（env.run）应答，
 *     所有 HTTPS 取数由注入的假 httpsGetJson 应答；仓库根用临时目录，不碰真仓库。
 *   · 覆盖任务硬性要求：dry-run 五步 / 原子写 + --resume 只补缺失 / npm 已存在 SKIP /
 *     Release 资产 sha256 一致 SKIP / sha256 不一致明确报错 / 统计失败仍 exit 0 / latest 未确认拒绝。
 *
 * 用法：node tools/dev/test-publish-all.mjs
 * 输出：每项 PASS/FAIL + 末尾 `RESULT: PASS|FAIL`；退出码 0 = 全过，1 = 有失败。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { assetSha256, main, parseGhSlugFromUrl, readState, STEPS, statePath, writeState } from "./publish-all.mjs";

const PKG_NAME = "dsh-drydock";
const VERSION = "1.1.0-rc.1";
const TGZ_NAME = `${PKG_NAME}-${VERSION}.tgz`;
const SLUG = "nonentity303/dsh-drydock";
const HEAD = "a".repeat(40);
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ──────────────────────────────────────────────────────────────
// 断言 / 用例注册
// ──────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tmpDirs = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertContains(haystack, needle, label) {
  assert(String(haystack).includes(needle), `${label}：期望输出包含 ${JSON.stringify(needle)}，实际未出现`);
}
function assertNotContains(haystack, needle, label) {
  assert(!String(haystack).includes(needle), `${label}：输出不该包含 ${JSON.stringify(needle)}`);
}

// ──────────────────────────────────────────────────────────────
// 临时仓库 + 假执行器
// ──────────────────────────────────────────────────────────────
function mkTmpRepo() {
  const root = mkdtempSync(join(tmpdir(), "dsh-puball-"));
  tmpDirs.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: PKG_NAME, version: VERSION, repository: { type: "git", url: `git+https://github.com/${SLUG}.git` } }, null, 1),
    "utf8",
  );
  mkdirSync(join(root, "docs", "releases"), { recursive: true });
  writeFileSync(join(root, "docs", "releases", `${VERSION}.md`), `# ${VERSION}\n发布说明\n`, "utf8");
  return root;
}

function makeAsset(env, content = env.tgzContent) {
  return {
    name: TGZ_NAME,
    size: Buffer.byteLength(content),
    digest: `sha256:${sha(content)}`,
    label: `${TGZ_NAME} (SHA256 ${sha(content).toUpperCase()})`,
    downloadCount: 0,
  };
}

function makeRun(env) {
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const bad = (stderr = "", code = 1) => ({ code, stdout: "", stderr });
  const record = (kind, extra = {}) => env.calls.push({ kind, ...extra });
  const isPrereleaseVersion = () => VERSION.includes("-");

  const npmCall = (a) => {
    const sub = a[0];
    if (sub === "whoami") {
      if (env.whoami === null) return bad("npm error code E401\nnpm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami\nnpm error A complete log…");
      return ok(`${env.whoami}\n`);
    }
    if (sub === "view") {
      const what = a[2];
      if (what === "versions") return ok(JSON.stringify(env.versions));
      if (what === "dist-tags") return ok(JSON.stringify(env.distTags));
      return bad(`unexpected npm view ${a.join(" ")}`);
    }
    return bad(`unexpected npm ${a.join(" ")}`);
  };

  return (cmd, args = [], opts = {}) => {
    const isNode = resolve(cmd) === resolve(process.execPath);
    const first = isNode ? args[0] : null;
    const line = args.join(" ");

    // npm（node <npm-cli.js> … 或裸 npm …）
    if (isNode && first && /npm-cli\.js$/i.test(first)) return npmCall(args.slice(1));
    if (cmd === "npm") return npmCall(args);

    // 本仓库的 node 工具脚本
    if (isNode && first && /pack\.mjs$/.test(first)) {
      record("pack");
      writeFileSync(env.tgzPath, env.tgzContent);
      return ok(`[pack] expected artifact: ${TGZ_NAME}\n`);
    }
    if (isNode && first && /publish-npm\.mjs$/.test(first)) {
      record("publish", { args });
      if (env.publishFails) return bad("npm error code EOTP\nnpm error This operation requires a one-time password\n");
      if (!env.versions.includes(VERSION)) env.versions = [...env.versions, VERSION];
      env.distTags = { ...env.distTags, next: VERSION };
      return ok(`+ ${PKG_NAME}@${VERSION}\n`);
    }
    if (isNode && first && /verify-triple\.mjs$/.test(first)) {
      record("verify-triple", { args });
      if (!env.verifyTripleOk) return ok(`\n结论：git 远端 ↔ npm 线上 ↔ 本地 ❌ 存在差异（见上表）\n`);
      return ok(`\n结论：git 远端 ↔ npm 线上 ↔ 本地 ✅ 三者逐文件 sha256 完全一致\n`);
    }

    // git
    if (cmd === "git") {
      if (line === "remote get-url origin") return env.remote ? ok(`${env.remote}\n`) : bad("error: No such remote 'origin'", 2);
      if (line === "rev-parse --abbrev-ref HEAD") return ok(`${env.branch}\n`);
      if (line.startsWith("rev-list --count")) return ok("0\n");
      if (line === "rev-parse HEAD") return ok(`${env.headSha}\n`);
      if (line.startsWith("rev-parse --verify refs/tags/")) return env.localTagExists ? ok(`${env.headSha}\n`) : bad("fatal: not a valid object name", 128);
      if (line.startsWith("tag -a ")) {
        record("tag-create");
        env.localTagExists = true;
        return ok();
      }
      if (line.startsWith("push origin ")) {
        record("tag-push");
        if (env.pushFails) return bad("Connection was reset, errno 10054", 128);
        env.remoteTag = { exists: true, commit: env.headSha };
        return ok();
      }
      return bad(`unexpected git ${line}`, 127);
    }

    // gh
    if (cmd === "gh") {
      if (line === "--version") return ok("gh version 2.102.0 (2026-09-30)\n");
      if (line === "auth status") {
        if (env.ghAuth === false) return bad("You are not logged into any GitHub hosts. Run gh auth login", 1);
        return ok("github.com\n  ✓ Logged in to github.com account nonentity303 (keyring)\n");
      }
      if (args[0] === "release" && args[1] === "view") {
        record("release-view");
        if (!env.release.exists) return bad("release not found", 1);
        return ok(JSON.stringify({ tagName: env.release.tagName, isPrerelease: env.release.isPrerelease, url: `https://github.com/${SLUG}/releases/tag/${env.release.tagName}`, assets: env.release.assets }));
      }
      if (args[0] === "release" && args[1] === "create") {
        record("release-create", { args });
        if (env.createFails) return bad("Post \"https://api.github.com/repos/…/releases\": read tcp 10.0.0.1:54321->140.82.113.6:443: wsarecv: An existing connection was forcibly closed by the remote host.");
        env.release = { exists: true, tagName: args[2], isPrerelease: isPrereleaseVersion(), assets: [makeAsset(env)] };
        return ok(JSON.stringify({ url: `https://github.com/${SLUG}/releases/tag/${args[2]}` }));
      }
      if (args[0] === "release" && args[1] === "upload") {
        record("release-upload", { args });
        if (env.uploadFails) return bad("HTTP 422: Validation Failed", 1);
        if (env.release.exists) env.release.assets.push(makeAsset(env));
        return ok("");
      }
      if (args[0] === "release" && args[1] === "list") {
        return ok(JSON.stringify([{ tagName: "v1.0.1", isLatest: true, isPrerelease: false }]));
      }
      if (args[0] === "api") {
        const pathArg = args.find((x) => String(x).startsWith("repos/")) || "";
        if (pathArg.includes("/releases?per_page=")) {
          record("gh-releases");
          return ok(JSON.stringify([[{ tag_name: "v1.0.1", prerelease: false, assets: [{ name: `${PKG_NAME}-1.0.1.tgz`, download_count: 1, size: 1024 }] }]]));
        }
        if (pathArg.includes("/releases/tags/")) {
          record("gh-tag");
          if (!env.release.exists) return bad("Not Found", 1);
          return ok(JSON.stringify({ tag_name: env.release.tagName, prerelease: env.release.isPrerelease, assets: env.release.assets.map((a) => ({ name: a.name, download_count: a.downloadCount || 0 })) }));
        }
        if (pathArg.includes("/git/ref/tags/")) {
          record("gh-ref-tag");
          if (!env.remoteTag.exists) return bad("Not Found", 1);
          return ok(JSON.stringify({ object: { type: "commit", sha: env.remoteTag.commit } }));
        }
        return bad(`unexpected gh api ${pathArg}`);
      }
      return bad(`unexpected gh ${line}`);
    }

    record("unexpected", { cmd, args });
    return bad(`unexpected command: ${cmd} ${line}`);
  };
}

/** 造一个"健康但两边都还没发这一版"的环境。 */
function baseEnv(over = {}) {
  const root = mkTmpRepo();
  const env = {
    root,
    remote: `git@github.com:${SLUG}.git`,
    branch: "master",
    headSha: HEAD,
    whoami: "nonentity303",
    ghAuth: true,
    versions: [],
    distTags: { latest: "1.0.1" },
    release: { exists: false },
    remoteTag: { exists: false, commit: null },
    localTagExists: false,
    createFails: false,
    uploadFails: false,
    pushFails: false,
    publishFails: false,
    verifyTripleOk: true,
    tgzContent: "FAKE-TGZ-PAYLOAD-FOR-TESTS",
    downloads: { week: 257, month: 1033 },
    downloadFails: false,
    ...over,
  };
  env.calls = [];
  env.tgzName = TGZ_NAME;
  env.tgzPath = join(root, TGZ_NAME);
  env.tgzSha = sha(env.tgzContent);
  env.run = makeRun(env);
  env.httpsGetJson = async (url) => {
    if (env.downloadFails) throw new Error("ECONNRESET（模拟被墙）");
    const isMonth = String(url).includes("last-month");
    return { downloads: isMonth ? env.downloads.month : env.downloads.week, start: "2026-11-19", end: "2026-11-25" };
  };
  return env;
}

async function runMain(env, argv) {
  const logs = [];
  const code = await main(argv, {
    root: env.root,
    run: env.run,
    httpsGetJson: env.httpsGetJson,
    log: (line = "") => logs.push(String(line)),
  });
  return { code, logs, text: logs.join("\n") };
}

const kinds = (env) => env.calls.map((c) => c.kind);
const countKind = (env, kind) => kinds(env).filter((k) => k === kind).length;

function assertNoUnexpected(env) {
  const un = env.calls.filter((c) => c.kind === "unexpected");
  assert(un.length === 0, `出现了未预期的外部命令：${un.map((c) => `${c.cmd} ${c.args.join(" ")}`).join(" | ")}`);
}

function assertNoTmpLeftovers(root) {
  const leftovers = readdirSync(root).filter((f) => f.startsWith(".publish-state.json.tmp"));
  assert(leftovers.length === 0, `状态文件留下了临时文件：${leftovers.join(", ")}`);
}

// ──────────────────────────────────────────────────────────────
// 用例
// ──────────────────────────────────────────────────────────────

test("dry-run 打印全部 5 步，且不写状态文件、不产生任何写命令", async () => {
  const env = baseEnv();
  const r = await runMain(env, []);
  for (let i = 0; i < STEPS.length; i++) assertContains(r.text, `[${i + 1}/${STEPS.length}] ${STEPS[i]}`, "dry-run 步骤行");
  assertContains(r.text, "预演", "dry-run 模式说明");
  assert(r.code === 0, `健康环境下 dry-run 应 exit 0，实际 ${r.code}\n${r.text.slice(-600)}`);
  assert(!existsSync(statePath(env.root)), "dry-run 不应写状态文件");
  for (const kind of ["pack", "publish", "tag-create", "tag-push", "release-create", "release-upload", "verify-triple"]) {
    assert(countKind(env, kind) === 0, `dry-run 不应真的执行 ${kind}`);
  }
  assertNoUnexpected(env);
});

test("--apply 中途失败：状态文件原子写、已完成步骤保留、lastError 记录 stderr 尾部", async () => {
  const env = baseEnv({ createFails: true });
  const r = await runMain(env, ["--apply"]);
  assert(r.code === 1, `gh 失败时应 exit 1，实际 ${r.code}`);

  const st = readState(env.root);
  assert(st, "状态文件应该存在");
  assert(st.version === VERSION, `状态文件 version 应为 ${VERSION}，实际 ${st.version}`);
  assert(st.tag === "next", `状态文件 tag 应为 next，实际 ${st.tag}`);
  for (const step of ["preflight", "pack", "npm"]) assert(st.steps[step]?.status === "done", `${step} 应为 done，实际 ${JSON.stringify(st.steps[step])}`);
  assert(st.steps.gh?.status === "failed", `gh 应为 failed，实际 ${JSON.stringify(st.steps.gh)}`);
  assert(st.steps.verify === undefined, "失败后 verify 不该被执行/记录");
  assert(/^[0-9a-f]{64}$/.test(st.sha256 || ""), `sha256 应为 64 位 hex，实际 ${st.sha256}`);
  assert(st.tgzPath && existsSync(st.tgzPath), "tgzPath 应指向真实产物");
  assert(st.startedAt && st.finishedAt, "startedAt / finishedAt 都应有值");
  assert(st.lastError?.step === "gh", `lastError.step 应为 gh，实际 ${JSON.stringify(st.lastError)}`);
  assert(/forcibly closed|connection reset/i.test(st.lastError.errorText || ""), "lastError 应含 stderr 尾部（网络重置）");
  assertNoTmpLeftovers(env.root);
  assertNoUnexpected(env);

  // ── 修好网络后 --resume：只补 gh / verify，不重跑 pack / publish
  env.createFails = false;
  const made = { pack: countKind(env, "pack"), publish: countKind(env, "publish"), push: countKind(env, "tag-push") };
  const r2 = await runMain(env, ["--apply", "--resume"]);
  assert(r2.code === 0, `resume 修好后应 exit 0，实际 ${r2.code}\n${r2.text.slice(-800)}`);
  assertContains(r2.text, "--resume：该步已完成", "resume 跳过提示");
  assert(countKind(env, "pack") === made.pack, "resume 不应重跑 pack");
  assert(countKind(env, "publish") === made.publish, "resume 不应重跑 npm publish");
  assert(countKind(env, "tag-push") === made.push, "resume 不应重复 push tag");
  assert(countKind(env, "release-create") === 2, "release create 应在两轮里各尝试一次（首轮失败 + 补跑成功）");
  assert(countKind(env, "verify-triple") === 1, "verify-triple 应只在补跑时执行一次");

  const st2 = readState(env.root);
  assert(st2.steps.gh?.status === "done", `补跑后 gh 应为 done，实际 ${JSON.stringify(st2.steps.gh)}`);
  assert(st2.steps.verify?.status === "done", `补跑后 verify 应为 done，实际 ${JSON.stringify(st2.steps.verify)}`);
  assert(st2.lastError === null, `补跑成功后 lastError 应清空，实际 ${JSON.stringify(st2.lastError)}`);
  assertContains(r2.text, "双平台发布链路完成", "成功收尾");
});

test("npm 已存在同版本 → SKIP，且不调用 publish", async () => {
  const env = baseEnv({ versions: [VERSION], distTags: { latest: "1.0.1", next: VERSION } });
  env.release = { exists: true, tagName: `v${VERSION}`, isPrerelease: true, assets: [makeAsset(env)] };
  const r = await runMain(env, ["--apply"]);
  assert(r.code === 0, `全部幂等命中时应 exit 0，实际 ${r.code}\n${r.text.slice(-800)}`);
  assertContains(r.text, "[3/5] npm ⇒ SKIP", "npm 步应 SKIP");
  assertContains(r.text, "不重复发布", "SKIP 应说明原因");
  assert(countKind(env, "publish") === 0, "npm 已存在时不该调用 publish-npm.mjs");
  const st = readState(env.root);
  assert(st.steps.npm?.outcome === "SKIP" && st.steps.npm?.status === "done", `npm 步状态应为 SKIP/done，实际 ${JSON.stringify(st.steps.npm)}`);
  assertNoUnexpected(env);
});

test("Release 已存在且资产 sha256 一致 → SKIP（不重建、不重传）", async () => {
  const env = baseEnv({ versions: [VERSION], distTags: { latest: "1.0.1", next: VERSION } });
  env.release = { exists: true, tagName: `v${VERSION}`, isPrerelease: true, assets: [makeAsset(env)] };
  const r = await runMain(env, ["--apply"]);
  assert(r.code === 0, `应 exit 0，实际 ${r.code}\n${r.text.slice(-800)}`);
  assertContains(r.text, "[4/5] gh ⇒ SKIP", "gh 步应 SKIP");
  assertContains(r.text, "sha256 均一致", "SKIP 应说明 sha256 一致");
  assert(countKind(env, "release-create") === 0, "不该重复建 Release");
  assert(countKind(env, "release-upload") === 0, "不该重传资产");
  assert(countKind(env, "tag-create") === 0, "不该再打 tag");
});

test("资产 sha256 不一致 → 明确报错，绝不静默覆盖", async () => {
  const env = baseEnv({ versions: [VERSION], distTags: { latest: "1.0.1", next: VERSION } });
  env.release = { exists: true, tagName: `v${VERSION}`, isPrerelease: true, assets: [makeAsset(env, "这是另一份内容")] };
  const r = await runMain(env, ["--apply"]);
  assert(r.code === 1, `sha256 不一致时应 exit 1，实际 ${r.code}`);
  assertContains(r.text, "sha256 不一致", "应明确报 sha256 不一致");
  assertContains(r.text, "不自动覆盖", "应明确声明不覆盖");
  assert(countKind(env, "release-upload") === 0, "不一致时不该上传/覆盖");
  const st = readState(env.root);
  assert(st.steps.gh?.status === "failed", `gh 应为 failed，实际 ${JSON.stringify(st.steps.gh)}`);
  assertContains(r.text, "delete-asset", "应给出人工处置命令");
});

test("下载量 API 失败 → 打 unavailable，--status 仍 exit 0", async () => {
  const env = baseEnv({ downloadFails: true });
  const r = await runMain(env, ["--status"]);
  assert(r.code === 0, `统计失败不该让 --status 失败，实际 ${r.code}`);
  assertContains(r.text, "unavailable", "应打印 unavailable");
  assertContains(r.text, "npm 统计不可用", "应说明不可用原因");
  assertNoUnexpected(env);
});

test("--tag latest 不给 --yes → 拒绝执行（exit 2，零外部命令）", async () => {
  const env = baseEnv();
  const r = await runMain(env, ["--tag", "latest"]);
  assert(r.code === 2, `应 exit 2，实际 ${r.code}`);
  assertContains(r.text, "拒绝执行", "应明确拒绝");
  assertContains(r.text, "--yes", "应提示 --yes");
  assert(env.calls.length === 0, `拒绝执行时不该跑任何外部命令，实际跑了 ${env.calls.length} 条`);
});

test("Release 已存在但缺 tgz 资产 → 只补资产，不重建 Release", async () => {
  const env = baseEnv({ versions: [VERSION], distTags: { latest: "1.0.1", next: VERSION } });
  env.release = { exists: true, tagName: `v${VERSION}`, isPrerelease: true, assets: [] };
  const r = await runMain(env, ["--apply"]);
  assert(r.code === 0, `补资产应成功 exit 0，实际 ${r.code}\n${r.text.slice(-800)}`);
  assertContains(r.text, "补传缺失资产", "应说明补传");
  assert(countKind(env, "release-create") === 0, "不该重建 Release");
  assert(countKind(env, "release-upload") === 1, "应上传一次资产");
  const st = readState(env.root);
  assert(st.steps.gh?.outcome === "OK", `gh 应为 OK，实际 ${JSON.stringify(st.steps.gh)}`);
});

test("远端 tag 已存在但指向别的 commit → 明确报错，不覆盖", async () => {
  const env = baseEnv();
  env.remoteTag = { exists: true, commit: "b".repeat(40) };
  const r = await runMain(env, ["--apply"]);
  assert(r.code === 1, `tag 冲突应 exit 1，实际 ${r.code}`);
  assertContains(r.text, "内容不一致", "应说明 tag 内容不一致");
  assertContains(r.text, "脚本不覆盖", "应声明不覆盖");
  assert(countKind(env, "tag-create") === 0, "不该重打 tag");
  assert(countKind(env, "tag-push") === 0, "不该 push tag");
  assert(countKind(env, "release-create") === 0, "不该建 Release");
});

test("状态文件原子写：tmp + rename，覆盖后读回最新，不留 tmp", () => {
  const env = baseEnv();
  const base = {
    version: VERSION,
    tag: "next",
    steps: {},
    sha256: null,
    tgzPath: null,
    startedAt: "2026-11-26T00:00:00.000Z",
    finishedAt: null,
    lastError: null,
  };
  writeState(env.root, base);
  assert(existsSync(statePath(env.root)), "第一次写入后状态文件应存在");
  assertNoTmpLeftovers(env.root);
  writeState(env.root, { ...base, tag: "next-2", steps: { preflight: { status: "done" } } });
  const back = readState(env.root);
  assert(back && back.tag === "next-2", `覆盖写后应读回最新内容，实际 ${JSON.stringify(back && back.tag)}`);
  assert(back.steps.preflight.status === "done", "steps 应一并落盘");
  assert(JSON.parse(readFileSync(statePath(env.root), "utf8")).tag === "next-2", "文件内容是合法 JSON 且为最新");
  assertNoTmpLeftovers(env.root);
});

test("纯函数：SSH remote 解析 / 资产 sha256 提取", () => {
  assert(parseGhSlugFromUrl("git@github.com:nonentity303/dsh-drydock.git") === SLUG, "SSH 形式解析失败");
  assert(parseGhSlugFromUrl("https://github.com/nonentity303/dsh-drydock.git") === SLUG, "HTTPS 形式解析失败");
  assert(parseGhSlugFromUrl("garbage") === null, "非法地址应返回 null");
  assert(assetSha256({ digest: `sha256:${"c".repeat(64)}` }) === "c".repeat(64), "digest 提取失败");
  assert(assetSha256({ label: `x.tgz (SHA256 ${"d".repeat(64).toUpperCase()})` }) === "d".repeat(64), "label 提取失败");
  assert(assetSha256({}) === null, "无 digest / label 时应返回 null");
});

// ──────────────────────────────────────────────────────────────
// 跑
// ──────────────────────────────────────────────────────────────
let failed = 0;
for (const [i, t] of tests.entries()) {
  const label = `[${i + 1}/${tests.length}] ${t.name}`;
  try {
    await t.fn();
    console.log(`- ${label} … PASS`);
  } catch (e) {
    failed++;
    console.log(`- ${label} … FAIL`);
    console.log(`    ✘ ${e?.message || e}`);
  }
}

for (const d of tmpDirs) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
}

console.log("");
if (failed === 0) {
  console.log(`RESULT: PASS（${tests.length}/${tests.length} 项通过）`);
  process.exit(0);
} else {
  console.log(`RESULT: FAIL（${failed}/${tests.length} 项未通过）`);
  process.exit(1);
}
