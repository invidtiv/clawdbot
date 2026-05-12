/**
 * AcpRuntime implementation backed by the Claude Code CLI.
 *
 * Each ACP session maps to a Claude Code session (identified by session UUID).
 * Prompt turns spawn `claude -p --output-format stream-json` processes.
 * Session continuity is maintained via `--resume <session-id>`.
 */

import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
  PluginLogger,
} from "../runtime-api.js";
import type { ResolvedClaudeCodeConfig } from "./config.js";
import {
  spawnClaudeProcess,
  iterateClaudeEvents,
  type ClaudeProcessHandle,
  type ClaudeStreamEvent,
} from "./process.js";

export const CLAUDE_CODE_BACKEND_ID = "claude-code";

const CLAUDE_CODE_CAPABILITIES: AcpRuntimeCapabilities = {
  controls: ["session/set_mode", "session/status"],
};

type SessionState = {
  sessionKey: string;
  claudeSessionId?: string;
  agent: string;
  cwd: string;
  mode: "persistent" | "oneshot";
  activeProcess?: ClaudeProcessHandle;
};

function encodeHandleName(state: SessionState): string {
  const payload = Buffer.from(
    JSON.stringify({
      sessionKey: state.sessionKey,
      claudeSessionId: state.claudeSessionId,
      agent: state.agent,
      cwd: state.cwd,
      mode: state.mode,
    }),
    "utf8",
  ).toString("base64url");
  return `claude-code:v1:${payload}`;
}

function decodeHandleName(
  runtimeSessionName: string,
): Pick<SessionState, "sessionKey" | "claudeSessionId" | "agent" | "cwd" | "mode"> | null {
  if (!runtimeSessionName.startsWith("claude-code:v1:")) {
    return null;
  }
  try {
    const raw = Buffer.from(
      runtimeSessionName.slice("claude-code:v1:".length),
      "base64url",
    ).toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.sessionKey || !parsed.agent || !parsed.cwd) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Map a Claude Code stream event to an ACP runtime event.
 */
function mapStreamEventToAcpEvent(event: ClaudeStreamEvent): AcpRuntimeEvent | null {
  switch (event.type) {
    case "assistant": {
      // Claude Code stream-json assistant events have a `message` object
      // with `content` array containing text/tool_use blocks
      const message = (event as any).message;
      if (!message?.content) {
        return null;
      }

      // Extract text from content blocks
      const textParts: string[] = [];
      const toolCalls: AcpRuntimeEvent[] = [];

      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            type: "tool_call",
            text: `Tool: ${block.name ?? "unknown"}`,
            tag: "tool_call",
            toolCallId: block.id,
            title: block.name,
          });
        }
      }

      // Return text as a single delta, tool calls get yielded separately
      // For now return the first meaningful event
      const fullText = textParts.join("");
      if (fullText) {
        return { type: "text_delta", text: fullText };
      }
      if (toolCalls.length > 0) {
        return toolCalls[0];
      }
      return null;
    }

    case "result":
      if (event.subtype === "success") {
        return { type: "done", stopReason: "end_turn" };
      }
      if (event.subtype === "error") {
        return {
          type: "error",
          message: (event as any).error ?? "Unknown Claude Code error",
          retryable: false,
        };
      }
      return { type: "done", stopReason: event.subtype };

    case "system": {
      const subtype = (event as any).subtype ?? "";
      // Skip noisy hook events
      if (subtype.startsWith("hook_")) {
        return null;
      }
      return {
        type: "status",
        text: String((event as any).message ?? subtype ?? "system"),
        tag: "session_info_update",
      };
    }

    default:
      // Skip rate_limit_event and other non-essential events
      return null;
  }
}

export class ClaudeCodeRuntime implements AcpRuntime {
  private healthy = false;
  private readonly sessions = new Map<string, SessionState>();
  private readonly logger?: PluginLogger;

  constructor(
    private readonly config: ResolvedClaudeCodeConfig,
    opts?: { logger?: PluginLogger },
  ) {
    this.logger = opts?.logger;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  /**
   * Probe that the Claude Code CLI is available and responsive.
   */
  async probeAvailability(): Promise<void> {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(this.config.command, ["--version"], {
        timeout: 10_000,
      });
      const version = stdout.trim();
      this.logger?.info(`Claude Code CLI detected: ${version}`);
      this.healthy = true;
    } catch (err: any) {
      this.logger?.warn(`Claude Code CLI probe failed: ${err.message}`);
      this.healthy = false;
    }
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(this.config.command, ["--version"], {
        timeout: 10_000,
      });
      return {
        ok: true,
        message: `Claude Code CLI available: ${stdout.trim()}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        code: "CLAUDE_CODE_NOT_FOUND",
        message: `Claude Code CLI not available: ${err.message}`,
        installCommand: "npm install -g @anthropic-ai/claude-code",
        details: [
          `Tried command: ${this.config.command}`,
          err.code === "ENOENT" ? "Binary not found in PATH" : `Exit: ${err.status ?? err.code}`,
        ],
      };
    }
  }

  getCapabilities(): AcpRuntimeCapabilities {
    return CLAUDE_CODE_CAPABILITIES;
  }

  /**
   * Ensure a Claude Code session exists. For persistent mode, we track the session ID
   * so subsequent turns can `--resume` into the same conversation.
   */
  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const existing = this.sessions.get(input.sessionKey);
    if (existing) {
      return this.buildHandle(existing);
    }

    const state: SessionState = {
      sessionKey: input.sessionKey,
      claudeSessionId: input.resumeSessionId,
      agent: input.agent,
      cwd: input.cwd ?? this.config.defaultCwd,
      mode: input.mode,
    };

    this.sessions.set(input.sessionKey, state);
    this.logger?.info(
      `Claude Code session created: key=${input.sessionKey}, mode=${input.mode}, cwd=${state.cwd}`,
    );

    return this.buildHandle(state);
  }

  /**
   * Execute a prompt turn against Claude Code CLI.
   * Spawns a process with streaming JSON I/O, yields ACP events, and captures the session ID.
   */
  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const state = this.sessions.get(input.handle.sessionKey);
    if (!state) {
      yield {
        type: "error",
        message: `No session found for key: ${input.handle.sessionKey}`,
        code: "SESSION_NOT_FOUND",
        retryable: false,
      };
      return;
    }

    // Kill any active process for this session
    if (state.activeProcess) {
      state.activeProcess.kill();
      state.activeProcess = undefined;
    }

    const handle = spawnClaudeProcess({
      config: this.config,
      prompt: input.text,
      sessionId: state.claudeSessionId,
      cwd: state.cwd,
      env: input.handle.cwd ? { CLAUDE_CWD: input.handle.cwd } : undefined,
      signal: input.signal,
    });

    state.activeProcess = handle;

    // Collect stderr for error reporting
    let stderr = "";
    handle.proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    try {
      for await (const event of iterateClaudeEvents(handle)) {
        // Capture session ID for future resume
        if (event.type === "result" && "session_id" in event && event.session_id) {
          state.claudeSessionId = event.session_id as string;
        }

        const acpEvent = mapStreamEventToAcpEvent(event);
        if (acpEvent) {
          yield acpEvent;
        }
      }

      // Wait for process exit
      const exitCode = await waitForExit(handle.proc);

      // Filter known harmless stderr warnings
      const stderrTrimmed = stderr.trim();
      const isHarmlessStderr =
        !stderrTrimmed ||
        stderrTrimmed.includes("no stdin data received") ||
        stderrTrimmed.includes("Warning:");

      if (exitCode !== 0 && exitCode !== null && !isHarmlessStderr) {
        yield {
          type: "error",
          message: stderrTrimmed || `Claude Code exited with code ${exitCode}`,
          code: "PROCESS_EXIT_FAILURE",
          retryable: exitCode === 1,
        };
      }
    } catch (err: any) {
      if (err.name === "AbortError" || input.signal?.aborted) {
        yield { type: "done", stopReason: "cancelled" };
      } else {
        yield {
          type: "error",
          message: err.message ?? "Unknown error during Claude Code execution",
          retryable: false,
        };
      }
    } finally {
      state.activeProcess = undefined;
    }
  }

  async getStatus(input: { handle: AcpRuntimeHandle }): Promise<AcpRuntimeStatus> {
    const state = this.sessions.get(input.handle.sessionKey);
    if (!state) {
      return { summary: "Session not found" };
    }

    return {
      summary: state.activeProcess ? "Running" : "Idle",
      agentSessionId: state.claudeSessionId,
      details: {
        mode: state.mode,
        cwd: state.cwd,
        agent: state.agent,
        hasActiveProcess: !!state.activeProcess,
        claudeSessionId: state.claudeSessionId,
      },
    };
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const state = this.sessions.get(input.handle.sessionKey);
    if (state?.activeProcess) {
      this.logger?.info(
        `Cancelling Claude Code session: key=${input.handle.sessionKey}, reason=${input.reason ?? "user request"}`,
      );
      state.activeProcess.kill("SIGINT");
      state.activeProcess = undefined;
    }
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const state = this.sessions.get(input.handle.sessionKey);
    if (state?.activeProcess) {
      state.activeProcess.kill();
    }
    this.sessions.delete(input.handle.sessionKey);
    this.logger?.info(
      `Closed Claude Code session: key=${input.handle.sessionKey}, reason=${input.reason}`,
    );
  }

  private buildHandle(state: SessionState): AcpRuntimeHandle {
    return {
      sessionKey: state.sessionKey,
      backend: CLAUDE_CODE_BACKEND_ID,
      runtimeSessionName: encodeHandleName(state),
      cwd: state.cwd,
      agentSessionId: state.claudeSessionId,
    };
  }
}

/**
 * Wait for a child process to exit and return the exit code.
 */
function waitForExit(proc: import("node:child_process").ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve(proc.exitCode);
      return;
    }
    proc.on("exit", (code) => resolve(code));
  });
}
