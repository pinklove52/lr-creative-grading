#!/usr/bin/env node
// 环境预检器：安装、启动和写事务前运行。
// 只读检查，绝不修改网络、Lightroom 或任何配置；任何硬检查失败时，
// 调用方应拒绝写操作而不是尝试修复。输出机器可读 JSON。

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ACCEPTED_LR_VERSION_PREFIX, isAcceptedLrVersion } from "./version-policy.mjs";

const execFileAsync = promisify(execFile);

const LR_EXE = "C:\\Program Files\\Adobe\\Lightroom Classic 2026\\Lightroom.exe";
const NODE_MIN = 20;
const NODE_MAX = 26;

function result(name, ok, detail) {
  return { check: name, ok: Boolean(ok), detail: detail ?? null };
}

async function checkLrExecutable() {
  try {
    const stats = await fs.stat(LR_EXE);
    if (!stats.isFile()) return result("lr_executable", false, { path: LR_EXE, reason: "not a file" });
    let version = null;
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Item -LiteralPath '${LR_EXE}').VersionInfo.ProductVersion`,
      ], { timeout: 10_000, windowsHide: true });
      version = stdout.trim() || null;
    } catch {
      // 版本读取失败不视为硬失败；版本白名单单独检查。
    }
    return result("lr_executable", true, { path: LR_EXE, product_version: version });
  } catch (error) {
    return result("lr_executable", false, { path: LR_EXE, reason: String(error?.message ?? error) });
  }
}

async function checkLrVersionWhitelist(lr) {
  if (!lr.ok) return result("lr_version_whitelist", false, {
    accepted_prefix: ACCEPTED_LR_VERSION_PREFIX,
    match_mode: "prefix",
    actual: "unknown",
  });
  const actual = lr.detail?.product_version;
  const accepted = isAcceptedLrVersion(actual);
  // actual 为 null（读取失败）时不允许写操作。
  return result("lr_version_whitelist", accepted, {
    accepted_prefix: ACCEPTED_LR_VERSION_PREFIX,
    match_mode: "prefix",
    actual,
  });
}

async function checkNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = major >= NODE_MIN && major <= NODE_MAX;
  return result("node_version", ok, {
    actual: process.versions.node,
    supported: `${NODE_MIN}.x - ${NODE_MAX}.x`,
    host: `${process.platform} ${os.release()} (${os.arch()})`,
  });
}

async function checkQueueWritable() {
  const root = process.env.LR_CREATIVE_BRIDGE_QUEUE || path.join(process.env.APPDATA || "", "Adobe", "Lightroom", "LrCreativeGradingBridge-v2");
  try {
    await fs.mkdir(path.join(root, ".doctor-probe"), { recursive: true });
    const probe = path.join(root, ".doctor-probe", "probe.tmp");
    await fs.writeFile(probe, "probe", "utf8");
    await fs.rm(probe, { force: true });
    await fs.rm(path.join(root, ".doctor-probe"), { recursive: true, force: true });
    return result("queue_writable", true, { root });
  } catch (error) {
    return result("queue_writable", false, { root, reason: String(error?.message ?? error) });
  }
}

async function checkClashHbcRule() {
  // 只读检查 Clash 本地配置中是否存在 hbc.adobe.io 阻断规则；
  // 不修改任何文件，也不对该域名发起连接测试。
  const candidates = [
    process.env.CLASH_PROFILE_DIR,
    path.join(process.env.APPDATA || "", "io.github.clash-verge-rev.clash-verge-rev"),
    path.join(process.env.APPDATA || "", "clash-verge"),
    path.join(os.homedir(), ".config", "clash"),
  ].filter(Boolean);
  const scanDirs = [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      scanDirs.push(candidate);
    } catch {
      // 目录不存在则跳过
    }
  }
  let found = null;
  for (const dir of scanDirs) {
    const walk = async (dirPath) => {
      let entries;
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found) return;
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          await walk(full);
        } else if (/\.(ya?ml|yaml)$/i.test(entry.name)) {
          try {
            const text = await fs.readFile(full, "utf8");
            if (text.includes("hbc.adobe.io")) {
              found = { file: full };
              return;
            }
          } catch {
            // 忽略单个文件读取失败
          }
        }
      }
    };
    await walk(dir);
  }
  return result("clash_hbc_adobe_io_block", found !== null, {
    searched_dirs: scanDirs,
    rule_file: found?.file ?? null,
    note: "只读检查；未发起任何网络连接",
  });
}

async function checkPluginIntegrity() {
  const pluginDir = process.argv[2] || "C:\\Users\\lh\\Documents\\lr\\lightroom-file-polling-bridge\\plugin\\FileQueueBridge.lrplugin";
  const checksums = path.join(pluginDir, "checksums.txt");
  try {
    await fs.access(checksums);
    const lines = (await fs.readFile(checksums, "utf8")).split(/\r?\n/).filter(Boolean);
    const mismatches = [];
    for (const line of lines) {
      const [expected, relative] = line.trim().split(/\s+/);
      if (!expected || !relative) continue;
      const filePath = path.join(pluginDir, relative);
      let digest = null;
      try {
        digest = crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
      } catch {
        mismatches.push({ file: relative, reason: "missing" });
        continue;
      }
      if (digest !== expected) mismatches.push({ file: relative, reason: "digest mismatch" });
    }
    return result("plugin_integrity", mismatches.length === 0, { checksums, mismatches });
  } catch {
    // 尚无 checksums.txt：提示生成，不判失败（M4 交付物）。
    return result("plugin_integrity", true, { checksums: null, note: "checksums.txt 未生成；M4 前应补发" });
  }
}

async function checkAllowedDirs() {
  const allowed = (process.env.LR_BRIDGE_ALLOWED_DIRS || "").split(";").map((item) => item.trim()).filter(Boolean);
  if (allowed.length === 0) {
    return result("allowed_dirs", true, { note: "未配置 LR_BRIDGE_ALLOWED_DIRS；只读阶段不要求" });
  }
  const missing = [];
  for (const dir of allowed) {
    try {
      await fs.access(dir);
    } catch {
      missing.push(dir);
    }
  }
  return result("allowed_dirs", missing.length === 0, { configured: allowed, missing });
}

async function checkRecentLrCrashes() {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$since=(Get-Date).AddHours(-24); $events = Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$since} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'Lightroom' -and ($_.ProviderName -eq 'Application Error' -or $_.ProviderName -eq 'Windows Error Reporting') } | Select-Object -First 5; $events | ForEach-Object { $_.TimeCreated.ToString('o') + ' | ' + $_.ProviderName + ' | ' + ($_.Message -split \"`n\")[0] }",
    ], { timeout: 15_000, windowsHide: true });
    const events = stdout.trim().split(/\r?\n/).filter(Boolean);
    return result("windows_event_log", events.length === 0, {
      note: "最近 24 小时 Lightroom 崩溃/错误事件",
      events,
    });
  } catch (error) {
    return result("windows_event_log", true, { note: "事件日志不可读（权限或不可用），跳过", reason: String(error?.message ?? error) });
  }
}

async function main() {
  const lrExecutable = await checkLrExecutable();
  const checks = {
    lr_executable: lrExecutable,
    lr_version_whitelist: await checkLrVersionWhitelist(lrExecutable),
    node_version: await checkNodeVersion(),
    queue_writable: await checkQueueWritable(),
    clash_hbc_adobe_io_block: await checkClashHbcRule(),
    plugin_integrity: await checkPluginIntegrity(),
    allowed_dirs: await checkAllowedDirs(),
    windows_event_log: await checkRecentLrCrashes(),
  };
  const hard = [checks.lr_executable, checks.node_version, checks.queue_writable];
  const report = {
    ok: hard.every((item) => item.ok),
    generated_at: new Date().toISOString(),
    host: `${process.platform} ${os.release()} (${os.arch()})`,
    node: process.versions.node,
    checks,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, fatal: String(error?.stack ?? error) })}\n`);
  process.exitCode = 1;
});
