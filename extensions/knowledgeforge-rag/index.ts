/**
 * KnowledgeForge RAG Plugin for OpenClaw Gateway
 *
 * Provides semantic search across the Obsidian vault, codebases,
 * and agent discoveries via the KnowledgeForge REST API.
 *
 * REST API endpoint: http://127.0.0.1:8742/api/v1
 */

const KF_API_FALLBACK = "http://127.0.0.1:8742/api/v1";

type ToolTextResult = {
  content: [{ type: "text"; text: string }];
  details?: unknown;
};

interface SearchResult {
  content: string;
  score?: number;
  collection: string;
  metadata: Record<string, unknown>;
}

interface SearchResponse {
  results: SearchResult[];
  total_results: number;
  search_time_ms: number;
}

function normalizeApiBase(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function resolveApiBase(pluginConfig?: Record<string, unknown>): string {
  const envBase = normalizeApiBase(process.env.KNOWLEDGEFORGE_API_URL);
  if (envBase) {
    return envBase;
  }
  const configBase = normalizeApiBase(pluginConfig?.apiUrl ?? pluginConfig?.endpoint);
  return configBase ?? KF_API_FALLBACK;
}

function textResult(text: string, details?: unknown): ToolTextResult {
  return details === undefined
    ? { content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }], details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toSearchResponse(raw: unknown): SearchResponse {
  if (!isRecord(raw)) {
    return { results: [], total_results: 0, search_time_ms: 0 };
  }

  const rows = Array.isArray(raw.results) ? raw.results : [];
  const results: SearchResult[] = rows
    .filter((row): row is Record<string, unknown> => isRecord(row))
    .map((row) => ({
      content: typeof row.content === "string" ? row.content : JSON.stringify(row.content ?? ""),
      score: typeof row.score === "number" && Number.isFinite(row.score) ? row.score : undefined,
      collection: typeof row.collection === "string" ? row.collection : "unknown",
      metadata: isRecord(row.metadata) ? row.metadata : {},
    }));

  const totalResults =
    typeof raw.total_results === "number" && Number.isFinite(raw.total_results)
      ? raw.total_results
      : results.length;
  const searchTimeMs =
    typeof raw.search_time_ms === "number" && Number.isFinite(raw.search_time_ms)
      ? raw.search_time_ms
      : 0;

  return {
    results,
    total_results: totalResults,
    search_time_ms: searchTimeMs,
  };
}

async function kfSearch(
  query: string,
  options?: {
    apiBase: string;
    collections?: string[];
    project?: string;
    n_results?: number;
  },
): Promise<SearchResponse> {
  const res = await fetch(`${options?.apiBase ?? KF_API_FALLBACK}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      collections: options?.collections,
      project: options?.project,
      n_results: options?.n_results ?? 5,
    }),
  });
  if (!res.ok) {
    throw new Error(`KnowledgeForge search failed: ${res.status}`);
  }
  return toSearchResponse(await res.json());
}

async function kfStoreDiscovery(
  content: string,
  options?: {
    apiBase: string;
    context?: string;
    project?: string;
    category?: string;
    severity?: string;
  },
): Promise<unknown> {
  const res = await fetch(`${options?.apiBase ?? KF_API_FALLBACK}/discoveries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      context: options?.context ?? "",
      project: options?.project ?? "",
      category: options?.category ?? "gotcha",
      severity: options?.severity ?? "important",
      source_agent: "openclaw-gateway",
    }),
  });
  if (!res.ok) {
    throw new Error(`KnowledgeForge store failed: ${res.status}`);
  }
  return res.json();
}

async function kfHealth(apiBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Export plugin registration
export default {
  id: "knowledgeforge-rag",
  name: "KnowledgeForge RAG",
  description: "Semantic search across Obsidian vault, codebases, and discoveries",

  register(api: any) {
    const pluginConfig =
      api.pluginConfig && typeof api.pluginConfig === "object"
        ? (api.pluginConfig as Record<string, unknown>)
        : undefined;
    const apiBase = resolveApiBase(pluginConfig);

    // Tool: Search knowledge base
    api.registerTool?.({
      label: "Knowledge Search",
      name: "knowledgeforge_search",
      description:
        "Search the local knowledge base (Obsidian vault, codebases, past discoveries) " +
        "using semantic similarity. Returns relevant documentation, code, and insights.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text" },
          collections: {
            type: "string",
            description: "Comma-separated: documents,codebase,discoveries (default: all)",
          },
          project: { type: "string", description: "Filter by project name" },
          n_results: { type: "number", description: "Number of results (default: 5)" },
        },
        required: ["query"],
      },
      execute: async (_toolCallId: string, args: any) => {
        const collections = args.collections
          ? args.collections.split(",").map((c: string) => c.trim())
          : undefined;
        const response = await kfSearch(args.query, {
          apiBase,
          collections,
          project: args.project,
          n_results: args.n_results,
        });
        const formatted = response.results
          .map(
            (r, i) =>
              `[${i + 1}] (score: ${typeof r.score === "number" ? r.score.toFixed(3) : "n/a"}, ${r.collection}) ` +
              `${r.metadata.source_file ?? "unknown"}\n${r.content.slice(0, 400)}`,
          )
          .join("\n\n");
        const summary = `Found ${response.total_results} results (${response.search_time_ms}ms):`;
        return textResult(formatted ? `${summary}\n\n${formatted}` : summary, response);
      },
    });

    // Tool: Store discovery
    api.registerTool?.({
      label: "Store Discovery",
      name: "knowledgeforge_store_discovery",
      description:
        "Store a non-obvious insight or gotcha found during a conversation. " +
        "Categories: bugfix|gotcha|performance|config|pattern|dependency|workaround|security",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The discovery content" },
          context: { type: "string", description: "What you were working on" },
          project: { type: "string", description: "Related project name" },
          category: { type: "string", description: "Category (default: gotcha)" },
          severity: { type: "string", description: "critical|important|nice-to-know" },
        },
        required: ["content"],
      },
      execute: async (_toolCallId: string, args: any) => {
        const result = await kfStoreDiscovery(args.content, { ...args, apiBase });
        return textResult(JSON.stringify(result, null, 2), result);
      },
    });

    // Gateway method: health check
    api.registerGatewayMethod?.("knowledgeforge.health", async (opts: any) => {
      const healthy = await kfHealth(apiBase);
      opts.respond(true, { healthy, api_url: apiBase });
    });

    // Gateway method: search
    api.registerGatewayMethod?.("knowledgeforge.search", async (opts: any) => {
      try {
        const result = await kfSearch(opts.params.query, { ...opts.params, apiBase });
        opts.respond(true, result);
      } catch (err: any) {
        opts.respond(false, undefined, { message: err.message });
      }
    });
  },
};
