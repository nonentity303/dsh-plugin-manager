// tools/dev/open-url.mjs — 给 npm 用的 BROWSER 接管脚本。
// npm 的 web-2FA 流程（lib/utils/auth.js 的 otplease → webAuthOpener）会先调
// createOpener(...) 打开一个网址，然后轮询 doneUrl 取回 otp。
// 把 BROWSER 指向本脚本，就能：① 把**未打码**的真实授权网址落盘（npm 终端输出里是 ***）
// ② 用系统默认浏览器（Edge）打开它，让 Windows Hello / 密码管理器能正常弹窗。
//
// 用法: node tools/dev/open-url.mjs <url>
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.argv[2] || "";
if (!url) process.exit(0);

const here = dirname(fileURLToPath(import.meta.url));
const logFile = join(here, "..", "..", "auth-urls.log");
const lastFile = join(here, "..", "..", "auth-url-last.txt");

writeFileSync(lastFile, url + "\n", "utf8");
appendFileSync(logFile, `${new Date().toISOString()} ${url}\n`, "utf8");
console.log(`[open-url] ${url}`);

// Windows: 用 cmd start 走系统默认浏览器（Edge），保留 # 等片段
try {
	spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
} catch (e) {
	console.error("[open-url] 打开失败:", e.message);
}
