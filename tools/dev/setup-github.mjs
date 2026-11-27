#!/usr/bin/env node
/**
 * setup-github.mjs — 一次性/幂等地把「Issue / PR 流程」需要的标签与里程碑建到仓库上。
 *
 * 为什么要有它：`.github/ISSUE_TEMPLATE/*.yml` 里写的 `labels: ["host-compat"]`、`track:desktop` 等，
 * **标签不存在时 GitHub 会静默忽略**（issue 建出来却没标签，流程等于没生效）。
 * 与其让维护者手动点二十下，不如把清单写成代码、可复跑、可审计。
 *
 * 安全默认：**默认 dry-run**（只打印将执行的 gh 命令，不写任何远端状态）；真执行必须显式 `--apply`。
 * 幂等：已存在的标签/里程碑跳过，不会覆盖颜色或描述（颜色变化请手动改，避免脚本覆盖你的个性化调整）。
 *
 * 用法（在仓库根或任意目录，需 gh 已登录）：
 *   node tools/dev/setup-github.mjs            # 预演：列出将创建什么
 *   node tools/dev/setup-github.mjs --apply    # 真创建（幂等）
 *
 * 退出码：0 = 正常；1 = 有失败；2 = 用法错误（gh 不可用 / 未登录）
 *
 * ⚠️ 这是**外部写操作**（动 GitHub 仓库状态）。按项目红线：执行前应得到维护者明确同意。
 */
import { execFileSync } from "node:child_process";

const REPO = "nonentity303/dsh-drydock";

/** 标签：name / color / description（颜色沿用 GitHub 语义色，便于一眼区分）。 */
const LABELS = [
  // 通道（与 release/channels.json 的 trackLabel 对应）
  { name: "track:web", color: "1d76db", description: "网页 / 引擎宿主（主线通道，npm latest / next）" },
  { name: "track:desktop", color: "5319e7", description: "官方桌面宿主（npm dist-tag desktop，永远预发布形态）" },
  { name: "track:community", color: "c5def5", description: "社区桌面发行版（占位：通道暂未启用）" },
  // 类型（默认标签已有 bug / enhancement / documentation / question，这里补齐流程用到的）
  { name: "host-compat", color: "fbca04", description: "宿主形态下的兼容性问题（要求贴 dsh-drydock-doctor --json）" },
  { name: "desktop-change", color: "d93f0b", description: "改动触及热文件且超污染预算（+80/−20），需单独审 web 影响面" },
  { name: "needs-real-machine", color: "b60205", description: "需真桌面运行时验证才能定性" },
  { name: "backport", color: "0e8a16", description: "需回移到维护线（请注明目标线）" },
  { name: "release-blocker", color: "b60205", description: "挡住下一次发布" },
  { name: "security", color: "ee0701", description: "安全相关问题（敏感细节请走私密漏洞报告，不要开公开 issue）" },
];

/** 里程碑：按轨道建，避免"所有事都堆在一个版本号里"。 */
const MILESTONES = [
  {
    title: "web-next",
    description: "网页/引擎主线的下一个发布（正式版或 -rc.N）。含共享代码修复与新功能。",
  },
  {
    title: "desktop-host-compat",
    description: "官方桌面宿主的适配与真机验证（-desktop.N 通道）。宿主动一次，这里动一次。",
  },
  {
    title: "release-infra",
    description: "发布链路与项目管理本身的改进（通道配置、CI、模板、文档）。",
  },
];

const log = (line = "") => process.stdout.write(`${line}\n`);

function run(args, { quiet = true } = {}) {
  try {
    const out = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out };
  } catch (error) {
    return {
      ok: false,
      error: `${error instanceof Error ? error.message : String(error)}${quiet ? "" : `\n${error.stderr ?? ""}`}`,
      out: String(error.stdout ?? ""),
    };
  }
}

function ghAvailable() {
  const r = run(["auth", "status"]);
  if (!r.ok) {
    const hint = /EPERM/.test(String(r.error))
      ? "（受限沙箱里 Node 无法 spawn gh —— 这是已知边界，请在普通终端里跑本脚本）"
      : "";
    return { ok: false, error: `${r.error}${hint}` };
  }
  if (!/Logged in to github\.com/.test(r.out)) return { ok: false, error: "gh 已安装但未登录（gh auth login）" };
  return { ok: true };
}

function existingLabels() {
  const r = run(["label", "list", "-R", REPO, "-L", "200", "--json", "name"]);
  if (!r.ok) return null;
  try {
    return new Set(JSON.parse(r.out).map((x) => x.name));
  } catch {
    return null;
  }
}

function existingMilestones() {
  const r = run(["api", `repos/${REPO}/milestones?state=all&per_page=100`, "--jq", ".[].title"]);
  if (!r.ok) return null;
  return new Set(r.out.split("\n").map((s) => s.trim()).filter(Boolean));
}

export function main(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const unknown = argv.filter((a) => a !== "--apply" && a !== "--help" && a !== "-h");
  if (unknown.length > 0) {
    log(`未知参数：${unknown.join(" ")}`);
    log("用法：node tools/dev/setup-github.mjs [--apply]");
    return 2;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    log("用法：node tools/dev/setup-github.mjs [--apply]");
    log("  默认 dry-run；--apply 真创建（幂等：已存在的跳过）");
    return 0;
  }

  const gh = ghAvailable();
  if (!gh.ok) {
    log(`✘ gh 不可用：${gh.error}`);
    return 2;
  }

  const labels = existingLabels();
  const milestones = existingMilestones();

  log(`${apply ? "🚀 真执行" : "🧪 预演（dry-run，不写远端）"} · 仓库 ${REPO}`);
  log(`   已有标签 ${labels ? labels.size : "?"} 个，里程碑 ${milestones ? milestones.size : "?"} 个`);
  log("");

  const plan = [];
  for (const label of LABELS) {
    if (labels && labels.has(label.name)) {
      plan.push({ kind: "标签", name: label.name, action: "SKIP（已存在）" });
      continue;
    }
    plan.push({ kind: "标签", name: label.name, action: "CREATE", args: ["label", "create", label.name, "--color", label.color, "--description", label.description, "-R", REPO] });
  }
  for (const ms of MILESTONES) {
    if (milestones && milestones.has(ms.title)) {
      plan.push({ kind: "里程碑", name: ms.title, action: "SKIP（已存在）" });
      continue;
    }
    plan.push({ kind: "里程碑", name: ms.title, action: "CREATE", args: ["api", "-X", "POST", `repos/${REPO}/milestones`, "-f", `title=${ms.title}`, "-f", `description=${ms.description}`] });
  }

  for (const item of plan) {
    log(`  [${item.action.padEnd(13)}] ${item.kind} ${item.name}`);
  }

  const creates = plan.filter((p) => p.action === "CREATE");
  if (creates.length === 0) {
    log("\n✅ 全部已存在，无需创建");
    return 0;
  }
  if (!apply) {
    log(`\n将创建 ${creates.length} 项。确认要写远端时加 --apply：`);
    log("  node tools/dev/setup-github.mjs --apply");
    return 0;
  }

  let failed = 0;
  for (const item of creates) {
    const r = run(item.args, { quiet: false });
    if (r.ok) {
      log(`  ✅ ${item.kind} ${item.name}`);
    } else {
      failed += 1;
      log(`  ❌ ${item.kind} ${item.name}：${r.error.split("\n")[0]}`);
    }
  }
  if (failed > 0) {
    log(`\n${failed} 项失败`);
    return 1;
  }
  log(`\n✅ 完成：新增 ${creates.length} 项（标签用于 issue 模板自动打标；里程碑用于分轨道排期）`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("setup-github.mjs")) {
  process.exit(main());
}
