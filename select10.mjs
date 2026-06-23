/**
 * select10.mjs —— 从真实 SWE-bench Pro 数据里选 10 个有代表性的真实实例,写成 selected10.json。
 * 选取标准: 每个仓库挑一个【2~6 个源文件、≥1 个 FAIL_TO_PASS、补丁中位规模】的实例(多文件=介尺度有意义)。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dir, "..", "beta-mesoscale", "SWE-bench_Pro-os-main",
  "SWE-bench_Pro-os-main", "helper_code", "sweap_eval_full_v2.jsonl");

function parsedFiles(patch) {
  const f = [];
  for (const m of patch.matchAll(/diff --git a\/(\S+) b\//g)) {
    const p = m[1];
    if (/(^|\/)(test|tests|spec|__tests__)(\/|$)|_test\.|\.test\.|\.spec\./i.test(p)) continue;
    f.push(p);
  }
  return [...new Set(f)];
}

const rl = readline.createInterface({ input: fs.createReadStream(DATA) });
const byRepo = {};
for await (const line of rl) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (!o.patch) continue;
  const files = parsedFiles(o.patch);
  if (files.length < 2 || files.length > 6) continue;
  let ftp = o.FAIL_TO_PASS;
  if (typeof ftp === "string") { try { ftp = JSON.parse(ftp); } catch { ftp = []; } }
  if (!Array.isArray(ftp) || !ftp.length) continue;
  (byRepo[o.repo] = byRepo[o.repo] || []).push({
    instance_id: o.instance_id, repo: o.repo, lang: o.repo_language || "",
    nfiles: files.length, ftp: ftp.length, plen: o.patch.length, files,
  });
}

const pick = [];
for (const repo of Object.keys(byRepo)) {
  const cands = byRepo[repo].filter((r) => r.nfiles >= 2).sort((a, b) => a.plen - b.plen);
  if (cands.length) pick.push(cands[Math.floor(cands.length / 2)]); // 中位补丁规模
}
const sel = pick.sort((a, b) => b.ftp - a.ftp).slice(0, 10);
console.log(`仓库数=${Object.keys(byRepo).length}, 选出 ${sel.length} 个真实实例:`);
for (const p of sel) console.log(`  ${p.repo.padEnd(26)} files=${p.nfiles} ftp=${p.ftp}  ${p.instance_id.slice(0, 56)}`);
fs.writeFileSync(path.join(__dir, "selected10.json"), JSON.stringify(sel.map((s) => s.instance_id), null, 2));
console.log(`\n已写 selected10.json`);
