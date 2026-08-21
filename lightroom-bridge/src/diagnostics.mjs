// 结构化诊断日志（Node 侧）。
// 规则：MCP stdout 永不写日志；日志只进 stderr 与诊断文件；
// 每行一个 JSON，机器可解析；超过上限轮转归档。

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_BYTES = 1024 * 1024;

export class DiagnosticsLogger {
  constructor({ filePath = null, stderr = false, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.filePath = filePath;
    this.stderr = stderr;
    this.maxBytes = maxBytes;
  }

  async rotateIfNeeded() {
    if (!this.filePath) return;
    try {
      const stats = await fs.stat(this.filePath);
      if (stats.size < this.maxBytes) return;
      const archived = `${this.filePath}.1`;
      await fs.rm(archived, { force: true });
      await fs.rename(this.filePath, archived);
    } catch {
      // 首次写入时文件不存在等场景：忽略
    }
  }

  async write(level, event, fields = {}) {
    const entry = { ts: new Date().toISOString(), level, event, ...fields };
    const line = `${JSON.stringify(entry)}\n`;
    if (this.stderr) process.stderr.write(line);
    if (!this.filePath) return;
    try {
      await this.rotateIfNeeded();
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, "utf8");
    } catch (error) {
      // 诊断日志失败不得影响桥主流程
      process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "log_write_failed", message: String(error?.message ?? error) })}\n`);
    }
  }

  info(event, fields = {}) {
    return this.write("info", event, fields);
  }

  warn(event, fields = {}) {
    return this.write("warn", event, fields);
  }

  error(event, fields = {}) {
    return this.write("error", event, fields);
  }
}

export function createLogger(options = {}) {
  return new DiagnosticsLogger(options);
}
