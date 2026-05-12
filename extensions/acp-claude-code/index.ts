import type { OpenClawPluginApi } from "./runtime-api.js";
import { resolveClaudeCodeConfig, type ResolvedClaudeCodeConfig } from "./src/config.js";
import { createClaudeCodeRuntimeService } from "./src/service.js";

const plugin = {
  id: "acp-claude-code",
  name: "ACP Claude Code Runtime",
  description: "ACP runtime backend powered by the Claude Code CLI.",
  register(api: OpenClawPluginApi) {
    const pluginConfig =
      api.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : undefined;
    const config = resolveClaudeCodeConfig(pluginConfig);

    api.registerService(createClaudeCodeRuntimeService({ config }));

    // Gateway method: health check
    api.registerGatewayMethod?.("acp.claude-code.health", async (opts: any) => {
      try {
        const { execFileSync } = await import("node:child_process");
        const out = execFileSync(config.command, ["--version"], {
          timeout: 5_000,
          encoding: "utf8",
        }).trim();
        opts.respond(true, { healthy: true, version: out, command: config.command });
      } catch (err: any) {
        opts.respond(true, { healthy: false, error: err.message, command: config.command });
      }
    });

    // Gateway method: list sessions
    api.registerGatewayMethod?.("acp.claude-code.sessions", async (opts: any) => {
      try {
        const { execFileSync } = await import("node:child_process");
        const out = execFileSync(config.command, ["sessions", "list", "--json"], {
          timeout: 10_000,
          encoding: "utf8",
        }).trim();
        opts.respond(true, JSON.parse(out));
      } catch (err: any) {
        opts.respond(false, undefined, { message: err.message });
      }
    });
  },
};

export default plugin;
