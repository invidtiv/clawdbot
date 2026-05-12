/**
 * Configuration resolution for the ACP Claude Code runtime.
 *
 * Merges plugin config from openclaw.plugin.json / gateway config
 * with environment variable overrides.
 */

export type ResolvedClaudeCodeConfig = {
  command: string;
  model?: string;
  permissionMode: string;
  defaultCwd: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  timeoutSeconds: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpConfig?: string;
};

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function positiveNumberOrDefault(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return fallback;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((s) => s.trim());
  return result.length > 0 ? result : undefined;
}

export function resolveClaudeCodeConfig(
  pluginConfig?: Record<string, unknown>,
): ResolvedClaudeCodeConfig {
  const envCommand = trimOrUndefined(process.env.CLAUDE_CODE_COMMAND);
  const envModel = trimOrUndefined(process.env.CLAUDE_CODE_MODEL);
  const envCwd = trimOrUndefined(process.env.CLAUDE_CODE_CWD);

  return {
    command: envCommand ?? trimOrUndefined(pluginConfig?.command) ?? "claude",
    model: envModel ?? trimOrUndefined(pluginConfig?.model),
    permissionMode: trimOrUndefined(pluginConfig?.permissionMode) ?? "plan",
    defaultCwd: envCwd ?? trimOrUndefined(pluginConfig?.defaultCwd) ?? process.cwd(),
    maxTurns: positiveNumberOrDefault(pluginConfig?.maxTurns, 25),
    maxBudgetUsd:
      typeof pluginConfig?.maxBudgetUsd === "number" &&
      Number.isFinite(pluginConfig.maxBudgetUsd) &&
      pluginConfig.maxBudgetUsd > 0
        ? pluginConfig.maxBudgetUsd
        : undefined,
    timeoutSeconds: positiveNumberOrDefault(pluginConfig?.timeoutSeconds, 300),
    systemPrompt: trimOrUndefined(pluginConfig?.systemPrompt),
    appendSystemPrompt: trimOrUndefined(pluginConfig?.appendSystemPrompt),
    allowedTools: toStringArray(pluginConfig?.allowedTools),
    disallowedTools: toStringArray(pluginConfig?.disallowedTools),
    mcpConfig: trimOrUndefined(pluginConfig?.mcpConfig),
  };
}
