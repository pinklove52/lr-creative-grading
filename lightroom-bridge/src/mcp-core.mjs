import {
  compileApplyTransaction,
  normalizeTarget,
  normalizeTransactionReference,
  toErrorData,
} from "./grade-session.mjs";

export const TOOL_DEFINITIONS = [
  {
    name: "capabilities",
    description: "Report Lightroom version, active module, supported parameters, ranges, and UI-only operations.",
    inputSchema: { type: "object", additionalProperties: false },
  },
  {
    name: "get_target_photo",
    description: "Return the active Lightroom photo identity plus source and baseline edit digests.",
    inputSchema: { type: "object", additionalProperties: false },
  },
  {
    name: "get_proxy",
    description: "Render the current Lightroom appearance to a JPEG proxy in a user-scoped temporary directory.",
    inputSchema: {
      type: "object",
      properties: {
        long_edge: { type: "integer", minimum: 256, maximum: 4096, default: 2048 },
        timeout_seconds: { type: "number", minimum: 1, maximum: 60, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_settings",
    description: "Read selected writable settings and the baseline digest from the active photo.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "object" },
        parameters: { type: "array", items: { type: "string" }, uniqueItems: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "apply_transaction",
    description: "Strictly validate and atomically apply a GradeSession-selected Lightroom recipe after taking a snapshot.",
    inputSchema: {
      type: "object",
      description: "A full GradeSession is preferred. A normalized target/candidate/selection request is also accepted.",
      required: ["session_version", "target", "candidates", "selection", "execution"],
      additionalProperties: true,
    },
  },
  {
    name: "readback",
    description: "Read actual values for a transaction and classify applied, skipped, unsupported, and failures.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        execution: { type: "object" },
        target: { type: "object" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rollback",
    description: "Restore the unique pre-transaction Lightroom snapshot after validating the target photo.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        execution: { type: "object" },
        target: { type: "object" },
      },
      additionalProperties: false,
    },
  },
];

export class McpCore {
  constructor(bridge) {
    this.bridge = bridge;
  }

  async callTool(name, args = {}) {
    switch (name) {
      case "capabilities":
      case "get_target_photo":
        return this.bridge.call(name, {});
      case "get_proxy":
        return this.bridge.call(name, args);
      case "get_settings": {
        const params = { ...args };
        if (params.target) params.target = normalizeTarget(params.target);
        return this.bridge.call(name, params);
      }
      case "apply_transaction":
        return this.bridge.call(name, compileApplyTransaction(args, { requireFullSession: true }));
      case "readback":
      case "rollback":
        return this.bridge.call(name, normalizeTransactionReference(args));
      default:
        throw Object.assign(new Error(`Unknown MCP tool: ${name}`), { code: "METHOD_NOT_FOUND" });
    }
  }

  async handleJsonRpc(message) {
    const { id, method, params = {} } = message;
    if (method === "initialize") {
      const requested = params.protocolVersion;
      const supported = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: supported.has(requested) ? requested : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lr-creative-grading-bridge", version: "0.1.0" },
        },
      };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFINITIONS } };
    }
    if (method === "tools/call") {
      try {
        const result = await this.callTool(params.name, params.arguments ?? {});
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          },
        };
      } catch (error) {
        const data = toErrorData(error);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: data }) }],
            structuredContent: { ok: false, error: data },
            isError: true,
          },
        };
      }
    }
    if (method?.startsWith("notifications/")) return null;
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }
}
