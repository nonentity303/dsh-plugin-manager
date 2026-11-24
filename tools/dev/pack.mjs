// pack.mjs — dev helper: build the client bundle, then produce the install tarball.
//
// Dev-only tool (not published). The canonical release path is `npm run pack`
// (see docs/RELEASING.md); this script exists for people who prefer a node entry
// point and it always operates on the repository root, regardless of cwd.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

console.log(`building + packing ${pkg.name}@${pkg.version} (root: ${ROOT})`);
execFileSync(process.execPath, [join(ROOT, "build.mjs")], { cwd: ROOT, stdio: "inherit" });
execFileSync(npm, ["pack"], { cwd: ROOT, stdio: "inherit" });
console.log(`expected artifact: ${pkg.name}-${pkg.version}.tgz (in ${ROOT})`);
