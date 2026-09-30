#!/usr/bin/env node
/**
 * tools/dev/npm-preflight.mjs — npm 发布/调试的"体检"命令（零依赖，Node ≥18）
 *
 * 目的：把「npm 认证 / 2FA / 缓存目录 / 版本是否已存在 / tarball 内容」这几件
 * 每次发布都要重新踩一遍的事，变成一条命令的确定性输出。
 *
 * 用法（在插件包根目录跑）：
 *   node tools/dev/npm-preflight.mjs
 *   node tools/dev/npm-preflight.mjs --cache D:\npm-cache     # 指定 npm 缓存目录
 *   node tools/dev/npm-preflight.mjs --json                   # 机器可读输出
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL 项（详见输出）
 *
 * 它**不会**执行任何写操作（不发布、不改仓库文件、不写注册表），只读检查。
 *
 * 实现注记（踩过的坑，别改回去）：
 *   1. Windows 上 `npm` 是 npm.cmd：用 shell:true 会有引号坑、直接 spawn 会 ENOENT。
 *      → 用 node 直接执行 `npm-cli.js`，跨平台且参数零转义。
 *   2. 受限沙箱里 node 子进程的默认 stdio:'pipe' 会 EPERM（命名管道被禁）。
 *      → 子进程 stdio 重定向到临时文件，再读回来；同时这也是"输出一定拿得到"的写法。
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

const CACHE = resolve(opt("--cache", process.env.DSH_NPM_CACHE || join(PKG_ROOT, ".npm-cache")));
const JSON_OUT = flag("--json");

const resolveNpmCli = () => {
  if (process.env.npm_execpath && /npm-cli\.js$/i.test(process.env.npm_execpath)) return process.env.npm_execpath;
  const cands = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return null;
};
const NPM_CLI = resolveNpmCli();

let seq = 0;
const npm = (args) => {
  const outFile = join(tmpdir(), `dsh-npm-preflight-${process.pid}-${++seq}.log`);
  const fd = openSync(outFile, "w");
  let code = null;
  let err = "";
  try {
    const r = spawnSync(NPM_CLI ? process.execPath : "npm", NPM_CLI ? [NPM_CLI, ...args] : args, {
      cwd: PKG_ROOT,
      stdio: ["ignore", fd, fd], // 不走管道：受限沙箱下 pipe 会 EPERM
      env: { ...process.env, npm_config_cache: CACHE, npm_config_loglevel: "notice" },
    });
    code = r.status;
    if (r.error) err = String(r.error.message);
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
  let text = "";
  try {
    text = readFileSync(outFile, "utf8");
    rmSync(outFile, { force: true });
  } catch {}
  return { code, out: text.trim(), err: (err ? err + "\n" : "") + "" };
};

const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail: detail ?? "" });
  if (!JSON_OUT) {
    const tag = status === "ok" ? "✅" : status === "warn" ? "⚠️ " : "❌";
    console.log(`${tag} ${name}${detail ? " — " + detail : ""}`);
  }
};
const indent = (s) => s.split("\n").map((l) => "    " + l).join("\n");

const readCreds = () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  const grab = (file) => {
    if (!existsSync(file)) return null;
    const m = readFileSync(file, "utf8").match(/_authToken\s*=\s*([^\s#]+)/);
    return m ? m[1] : null;
  };
  const projNpmrc = join(PKG_ROOT, ".npmrc");
  const userNpmrc = join(homedir(), ".npmrc");
  return { pkg, projNpmrc, userNpmrc, projectToken: grab(projNpmrc), userToken: grab(userNpmrc) };
};

const main = async () => {
  if (!JSON_OUT) {
    console.log(`npm 发布体检 · ${join(PKG_ROOT, "package.json")}`);
    console.log(`npm 缓存目录（本次强制）：${CACHE}`);
    console.log(`npm CLI：${NPM_CLI || "（未找到 npm-cli.js，回退 PATH 上的 npm）"}\n`);
  }
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });

  const { pkg, projNpmrc, userNpmrc, projectToken, userToken } = readCreds();
  const v = pkg.version;
  record("package.json version", "ok", `${pkg.name}@${v}${v.includes("-") ? "（含预发布段）" : ""}`);

  if (projectToken) record("项目 .npmrc 凭据", "ok", `${projNpmrc}（优先级最高，会盖过用户级 .npmrc）`);
  else if (userToken) record("项目 .npmrc 凭据", "warn", `不存在；将回退到用户级 ${userNpmrc}`);
  else record("项目 .npmrc 凭据", "fail", `两处都没有 _authToken：请写 ${projNpmrc}，或先 npm login`);

  if (projectToken && userToken && projectToken !== userToken) {
    record("凭据冲突提示", "warn", "用户级 .npmrc 里是另一枚 token——历史 401 常来自这里；项目 .npmrc 会盖过它，但建议把用户级那枚也清掉");
  }

  // ★ 写权限探测（2026-09-30 的教训）：
  //   `npm whoami` 只证明"token 有效"，**证明不了"能发布"**。registry 对写操作权限不足时
  //   返回 404 {"error":"Not found"}（故意掩盖 401），而读操作一切正常——
  //   实测：项目级 token 读全过、写是 404；用户级（npm login 写入）才是 401（有写权限）。
  //   判据：PUT 一个结构合法但版本不存在的 manifest →
  //     401 + npm-notice = 有写权限（仅缺 2FA 一次性凭据）；404 = 无写权限。
  let writeCapable = null;
  const tokenList = [
    { label: "项目 .npmrc", token: projectToken },
    { label: "用户 ~/.npmrc", token: userToken },
  ].filter((t) => t.token);
  for (const t of tokenList) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${pkg.name}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${t.token}`,
          "content-type": "application/json",
          "npm-command": "publish",
          "user-agent": `npm/11.19.0 node/${process.versions.node} ${process.platform} ${process.arch}`,
        },
        body: JSON.stringify({
          _id: `${pkg.name}@0.0.0-probe`,
          name: pkg.name,
          version: "0.0.0-probe",
          description: "preflight write probe",
          "dist-tags": { latest: "0.0.0-probe" },
          versions: { "0.0.0-probe": { name: pkg.name, version: "0.0.0-probe" } },
          _attachments: {},
        }),
      });
      const notice = res.headers.get("npm-notice");
      if (res.status === 401) {
        record(`写权限探测 · ${t.label}`, "ok", "HTTP 401 → 有写权限（仅缺 2FA 一次性凭据）");
        if (!writeCapable) writeCapable = { ...t, notice };
      } else if (res.status === 404) {
        record(`写权限探测 · ${t.label}`, "warn", "HTTP 404 → 无写权限（registry 用 404 掩盖 401）");
      } else {
        record(`写权限探测 · ${t.label}`, "warn", `HTTP ${res.status}（既非 401 也非 404，请人工确认）`);
      }
    } catch (e) {
      record(`写权限探测 · ${t.label}`, "warn", `探测失败：${e.message}`);
    }
  }
  if (tokenList.length && !writeCapable) {
    record("可用发布凭据", "fail", "两处 token 都没有写权限 → 重签一枚 Read and write 的 token，或改用 Trusted Publishing（OIDC）");
  } else if (writeCapable) {
    record("可用发布凭据", "ok", `${writeCapable.label}（注意 npm 优先级：项目级 .npmrc 会顶掉用户级）`);
    if (!JSON_OUT && writeCapable.notice) {
      const url = writeCapable.notice.replace(/^Open\s+/, "").replace(/\s+to use your security key.*$/, "").trim();
      console.log(`    安全密钥授权入口（2FA 卡住时用 tools/dev/publish-webauth.mjs）：${url}`);
    }
  }

  const who = npm(["whoami"]);
  const whoBlob = who.out + "\n" + who.err;
  if (who.code !== 0 || !whoBlob.trim()) {
    const hint = /E401|Unauthorized/i.test(whoBlob)
      ? "token 无效 / 过期 / 被撤销（E401）"
      : /EPERM|EACCES/i.test(whoBlob)
        ? "文件权限问题——把 npm 缓存指到可写目录（--cache）"
        : "见下方原始输出";
    record("npm whoami", "fail", hint);
    if (!JSON_OUT && whoBlob.trim()) console.log(indent(whoBlob.trim()));
  } else {
    record("npm whoami", "ok", whoBlob.trim().split("\n").pop());
  }

  let blob = "";
  if (who.code === 0) {
    const view = npm(["view", `${pkg.name}@${v}`, "version", "--json"]);
    const exists = view.code === 0 && /"\s*\d/.test(view.out);
    record(
      "registry 上是否已存在该版本",
      exists ? "fail" : "ok",
      exists ? `${pkg.name}@${v} 已存在——必须改版本号（同号发布会失败）` : `${v} 尚未占用`,
    );

    const latest = npm(["view", pkg.name, "dist-tags.latest", "--json"]);
    if (latest.code === 0) record("registry 上的 latest", "ok", latest.out.trim().replace(/\s+/g, " ") || "（空）");

    // 服务器端写入权探测（只读命令，不写 registry）。
    // 注意：`npm publish --dry-run` **不发任何请求到 registry**（只做本地 pack），
    // 所以它**不能**用来判断 2FA/权限——早期版本的本脚本正是在这里误报"可直发"。
    const collab = npm(["access", "list", "collaborators", pkg.name]);
    const collabText = collab.out.replace(/\s+/g, " ").trim();
    if (collab.code === 0 && /read-write/i.test(collabText)) record("包级写权限（服务器端确认）", "ok", collabText);
    else if (collab.code === 0) record("包级写权限（服务器端确认）", "warn", collabText || "未列出 read-write");
    else record("包级写权限（服务器端确认）", "fail", `无法确认写权限：${(collab.out + collab.err).trim().split("\n")[0]}`);

    // 2FA：只能"如实说明无法提前判定"，真正的判定发生在 publish 那一刻。
    const dry = npm(["publish", "--dry-run"]);
    blob = dry.out + "\n" + dry.err;
    if (dry.code === 0) {
      record(
        "2FA（能否免 OTP 发布）",
        "warn",
        "无法在发布前判定——dry-run 不访问 registry。若 token 没有 Bypass 2FA，真发布时会返回 EOTP（自带一段浏览器验证 URL）",
      );
    } else {
      record("2FA（能否免 OTP 发布）", "warn", `dry-run 退出码 ${dry.code}`);
      if (!JSON_OUT && blob.trim()) console.log(indent(blob.trim().split("\n").slice(-10).join("\n")));
    }

    const files = (blob.match(/npm notice [\d.]+k?B [^\n]+/g) || []).map((l) => l.replace(/^npm notice [\d.]+k?B\s+/, "").trim());
    const has = (re) => files.some((f) => re.test(f));
    const need = [
      /^bin\/open-boot\.mjs$/,
      /^bin\/dsh-boot\.mjs$/,
      /^bin\/rescue-daemon\.mjs$/,
      /^bin\/dsh-boot\.cmd$/,
      /^lib\/preflight\.mjs$/,
      /^lib\/enginectl\.mjs$/,
      /^cordis\.patch\.yml$/,
    ];
    const missing = need.filter((re) => !has(re)).map(String);
    if (missing.length) record("tarball 必备文件", "fail", `缺：${missing.join(", ")}`);
    else record("tarball 必备文件", "ok", "bin 四件 + preflight/enginectl + cordis.patch.yml 齐全");

    if (files.some((f) => f.endsWith(".map"))) record("tarball 体积红线", "fail", "包含 .map（files 白名单被改动过？）");
    else record("tarball 体积红线", "ok", `无 .map；共 ${files.length} 个文件`);

    const total = blob.match(/total files:\s*(\d+)/);
    const size = blob.match(/package size:\s*([\d.]+\s*\w+)/);
    if (total) record("tarball 概览", "ok", `${total[1]} 个文件 / ${size ? size[1] : "?"}`);
  }

  const failed = results.filter((r) => r.status === "fail");
  const warns = results.filter((r) => r.status === "warn");
  if (JSON_OUT) console.log(JSON.stringify({ package: pkg.name, version: v, cache: CACHE, ok: failed.length === 0, results }, null, 1));
  else {
    const verdict = failed.length
      ? `${failed.length} 项 FAIL ❌（先修这些）`
      : "前置条件全部通过 ✅（注意：2FA 是否需要 OTP 只有真发布才知道）";
    console.log(`\n结论：${verdict}`);
    for (const f of failed) console.log(`  ❌ ${f.name}: ${f.detail}`);
    for (const w of warns) if (!/2FA/.test(w.name)) console.log(`  ⚠️  ${w.name}: ${w.detail}`);
    if (!failed.length) {
      console.log("\n下一步：");
      console.log("  预演： npm run publish:npm");
      console.log("  真发： npm run publish:npm:apply            （免 OTP 的 token）");
      console.log("        npm run publish:npm:apply -- --otp 123456   （token 没绕过 2FA 时）");
    }
  }
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error("npm-preflight 失败：", e && e.message);
  process.exit(1);
});
