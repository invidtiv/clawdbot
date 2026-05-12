/**
 * OpenClaw plugin service for the Claude Code ACP runtime backend.
 *
 * Registers the ClaudeCodeRuntime as an ACP backend on start,
 * probes health with retries, and unregisters on stop.
 */

import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "../runtime-api.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../runtime-api.js";
import type { ResolvedClaudeCodeConfig } from "./config.js";
import { CLAUDE_CODE_BACKEND_ID, ClaudeCodeRuntime } from "./runtime.js";

const HEALTH_PROBE_RETRY_DELAYS_MS = [500, 2_000, 5_000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CreateClaudeCodeRuntimeServiceParams = {
  config: ResolvedClaudeCodeConfig;
};

export function createClaudeCodeRuntimeService(
  params: CreateClaudeCodeRuntimeServiceParams,
): OpenClawPluginService {
  let runtime: ClaudeCodeRuntime | null = null;
  let lifecycleRevision = 0;

  return {
    id: "acp-claude-code-runtime",

    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const { config } = params;

      runtime = new ClaudeCodeRuntime(config, { logger: ctx.logger });

      registerAcpRuntimeBackend({
        id: CLAUDE_CODE_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });

      ctx.logger.info(
        `Claude Code ACP backend registered (command: ${config.command}, model: ${config.model ?? "default"}, permission: ${config.permissionMode})`,
      );

      // Background health probe with retries
      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;

      void (async () => {
        try {
          for (let attempt = 0; attempt <= HEALTH_PROBE_RETRY_DELAYS_MS.length; attempt += 1) {
            await runtime?.probeAvailability();
            if (currentRevision !== lifecycleRevision) {
              return;
            }

            if (runtime?.isHealthy()) {
              ctx.logger.info(
                attempt === 0
                  ? "Claude Code ACP backend ready"
                  : `Claude Code ACP backend ready after ${attempt + 1} probe attempts`,
              );
              return;
            }

            const retryMs = HEALTH_PROBE_RETRY_DELAYS_MS[attempt];
            if (retryMs == null) {
              break;
            }

            const report = await runtime?.doctor();
            if (currentRevision !== lifecycleRevision) {
              return;
            }

            ctx.logger.warn(
              `Claude Code probe attempt ${attempt + 1} failed: ${report?.message ?? "unhealthy"}; retrying in ${retryMs}ms`,
            );
            await delay(retryMs);
            if (currentRevision !== lifecycleRevision) {
              return;
            }
          }

          const report = await runtime?.doctor();
          ctx.logger.warn(
            `Claude Code ACP backend probe failed: ${report?.message ?? "backend remained unhealthy"}` +
              (report?.installCommand ? ` | Install: ${report.installCommand}` : ""),
          );
        } catch (err) {
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          ctx.logger.warn(
            `Claude Code ACP setup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },

    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      unregisterAcpRuntimeBackend(CLAUDE_CODE_BACKEND_ID);
      runtime = null;
    },
  };
}
