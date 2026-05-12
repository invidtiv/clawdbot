/**
 * Claude Code CLI process manager.
 *
 * Spawns `claude` with `--output-format stream-json` and `--input-format stream-json`
 * for bidirectional NDJSON communication. Handles lifecycle, streaming, and cleanup.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { ResolvedClaudeCodeConfig } from "./config.js";

export type ClaudeStreamEvent =
  | { type: "assistant"; subtype: "text"; text: string }
  | {
      type: "assistant";
      subtype: "tool_use";
      tool_use: { id: string; name: string; input: unknown };
    }
  | {
      type: "result";
      subtype: "success";
      result: string;
      session_id?: string;
      cost_usd?: number;
      duration_ms?: number;
      usage?: Record<string, number>;
    }
  | { type: "result"; subtype: "error"; error: string; session_id?: string }
  | { type: "system"; subtype: string; [key: string]: unknown }
  | { type: string; subtype?: string; [key: string]: unknown };

export type ClaudeProcessHandle = {
  proc: ChildProcess;
  readline: ReadlineInterface;
  sessionId?: string;
  stdinWrite(message: string): void;
  kill(signal?: NodeJS.Signals): void;
};

/**
 * Build CLI arguments for a Claude Code invocation.
 */
export function buildClaudeArgs(options: {
  config: ResolvedClaudeCodeConfig;
  prompt?: string;
  sessionId?: string;
  cwd?: string;
}): string[] {
  const { config, prompt, sessionId } = options;
  const args: string[] = [];

  // Non-interactive print mode with streaming JSON I/O
  args.push("-p");
  args.push("--output-format", "stream-json");
  // No session persistence for ACP-managed sessions (we track session IDs ourselves)

  // Model
  if (config.model) {
    args.push("--model", config.model);
  }

  // Permission mode
  if (config.permissionMode === "bypass") {
    args.push("--dangerously-skip-permissions");
  } else if (config.permissionMode && config.permissionMode !== "default") {
    args.push("--permission-mode", config.permissionMode);
  }

  // Session management
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  // Limits
  if (config.maxTurns) {
    args.push("--max-turns", String(config.maxTurns));
  }
  if (config.maxBudgetUsd) {
    args.push("--max-budget-usd", String(config.maxBudgetUsd));
  }

  // System prompt
  if (config.systemPrompt) {
    args.push("--system-prompt", config.systemPrompt);
  }
  if (config.appendSystemPrompt) {
    args.push("--append-system-prompt", config.appendSystemPrompt);
  }

  // Tool restrictions
  if (config.allowedTools && config.allowedTools.length > 0) {
    args.push("--allowed-tools", config.allowedTools.join(","));
  }
  if (config.disallowedTools && config.disallowedTools.length > 0) {
    args.push("--disallowed-tools", config.disallowedTools.join(","));
  }

  // MCP config
  if (config.mcpConfig) {
    args.push("--mcp-config", config.mcpConfig);
  }

  // Initial prompt (must be last positional arg)
  if (prompt) {
    args.push(prompt);
  }

  return args;
}

/**
 * Spawn a Claude Code CLI process with streaming JSON I/O.
 */
export function spawnClaudeProcess(options: {
  config: ResolvedClaudeCodeConfig;
  prompt?: string;
  sessionId?: string;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}): ClaudeProcessHandle {
  const { config, prompt, sessionId, cwd, env, signal } = options;

  const args = buildClaudeArgs({ config, prompt, sessionId, cwd });
  const effectiveCwd = cwd ?? config.defaultCwd;

  const proc = spawn(config.command, args, {
    cwd: effectiveCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...env,
    },
    // Do NOT pass signal to spawn — it throws uncatchable AbortError in Bun.
    // We handle abort ourselves below.
  });

  const readline = createInterface({
    input: proc.stdout,
    crlfDelay: Infinity,
  });

  // Close stdin immediately — prompt is passed as a CLI arg, not via stdin.
  // This prevents Claude Code from waiting for stdin input.
  if (proc.stdin && !proc.stdin.destroyed) {
    proc.stdin.end();
  }

  let killed = false;

  const handle: ClaudeProcessHandle = {
    proc,
    readline,
    stdinWrite(message: string) {
      if (!killed && proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(message + "\n");
      }
    },
    kill(sig: NodeJS.Signals = "SIGTERM") {
      if (!killed) {
        killed = true;
        proc.kill(sig);
      }
    },
  };

  // Cleanup on abort
  if (signal) {
    const onAbort = () => handle.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    proc.on("exit", () => signal.removeEventListener("abort", onAbort));
  }

  return handle;
}

/**
 * Parse a single NDJSON line from Claude Code stdout.
 */
export function parseStreamLine(line: string): ClaudeStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ClaudeStreamEvent;
  } catch {
    return null;
  }
}

/**
 * Iterate over NDJSON events from a Claude process.
 */
export async function* iterateClaudeEvents(
  handle: ClaudeProcessHandle,
): AsyncIterable<ClaudeStreamEvent> {
  for await (const line of handle.readline) {
    const event = parseStreamLine(line);
    if (event) {
      // Capture session ID from result events
      if (event.type === "result" && "session_id" in event && event.session_id) {
        handle.sessionId = event.session_id;
      }
      yield event;
    }
  }
}
