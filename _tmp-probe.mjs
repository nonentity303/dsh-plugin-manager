import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHostProfile, resolveHostForm } from "./lib/host-profile.mjs";

const tmp = mkdtempSync(join(tmpdir(), "drydock-probe-"));
const dshHome = join(tmp, ".dsh");
const homeDir = tmp;
const env = { DSH_HOME: dshHome };
const probeOpts = { env, homeDir, platform: "win32" };

console.log("① 空环境:", JSON.stringify(resolveHostForm(probeOpts).form), resolveHostForm(probeOpts).reason.slice(0, 40));

mkdirSync(join(dshHome, "profiles", "desktop"), { recursive: true });
const r2 = resolveHostForm(probeOpts);
console.log("② 只有目录:", JSON.stringify(r2.form), "|", r2.reason.slice(0, 50));

writeFileSync(join(dshHome, "profiles", "desktop", "package.json"), '{"name":"desktop"}\n');
writeFileSync(join(dshHome, "profiles", "desktop", "lock"), "{}\n");
const r3 = resolveHostForm(probeOpts);
console.log("③ 目录+package.json+lock:", JSON.stringify(r3.form), "| confidence", r3.confidence, "|", r3.reason.slice(0, 60));

const ensured = ensureHostProfile({ ...probeOpts, dshHome });
console.log("④ ensure:", ensured.profile.form, "firstLaunch=", ensured.firstLaunch, "source=", ensured.source, "write=", JSON.stringify(ensured.write));
const again = ensureHostProfile({ ...probeOpts, dshHome });
console.log("⑤ 再调:", again.profile.form, "firstLaunch=", again.firstLaunch, "source=", again.source);

const forced = ensureHostProfile({ ...probeOpts, dshHome, force: true });
console.log("⑥ force:", forced.profile.form, "expired=", forced.expired, "profiledAt=", forced.profile.profiledAt);

const over = resolveHostForm({ ...probeOpts, env: { ...env, DSH_DRYDOCK_HOST: "desktop" } });
console.log("⑦ 覆盖:", over.form, over.source, over.confidence);
const bad = resolveHostForm({ ...probeOpts, env: { ...env, DSH_DRYDOCK_HOST: "foo" } });
console.log("⑧ 非法覆盖:", bad.form, bad.source, "evidence:", JSON.stringify(bad.evidence));

rmSync(tmp, { recursive: true, force: true });
