import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<unknown>;
};

function createPluginApiHarness(pluginConfig?: Record<string, unknown>) {
  const tools: RegisteredTool[] = [];
  const methods: string[] = [];

  return {
    tools,
    methods,
    api: {
      registerTool(tool: unknown) {
        if (
          tool &&
          typeof tool === "object" &&
          "name" in tool &&
          typeof (tool as { name?: unknown }).name === "string" &&
          "execute" in tool &&
          typeof (tool as { execute?: unknown }).execute === "function"
        ) {
          tools.push(tool as RegisteredTool);
        }
      },
      registerGatewayMethod(name: string) {
        methods.push(name);
      },
      pluginConfig,
    },
  };
}

describe("knowledgeforge-rag plugin tool results", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns OpenClaw content blocks for search results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              content: "Auth flow details",
              score: 0.9123,
              collection: "codebase",
              metadata: { source_file: "src/auth.ts" },
            },
          ],
          total_results: 1,
          search_time_ms: 12.3,
        }),
      }),
    );

    const { default: plugin } = await import("./index.ts");
    const harness = createPluginApiHarness();
    plugin.register?.(harness.api as never);

    const searchTool = harness.tools.find((tool) => tool.name === "knowledgeforge_search");
    expect(searchTool).toBeDefined();

    const result = await searchTool!.execute("call_1", { query: "auth flow" });
    const payload = result as { content?: unknown; details?: unknown };

    expect(Array.isArray(payload.content)).toBe(true);
    const blocks = payload.content as Array<{ type?: string; text?: string }>;
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.text).toContain("Found 1 results");
    expect(payload.details).toBeTruthy();
  });

  it("handles malformed search payloads without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: null,
          total_results: null,
          search_time_ms: null,
        }),
      }),
    );

    const { default: plugin } = await import("./index.ts");
    const harness = createPluginApiHarness();
    plugin.register?.(harness.api as never);

    const searchTool = harness.tools.find((tool) => tool.name === "knowledgeforge_search");
    expect(searchTool).toBeDefined();

    const result = await searchTool!.execute("call_2", { query: "broken response" });
    const blocks = (result as { content: Array<{ type?: string; text?: string }> }).content;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0]?.text).toContain("Found 0 results");
  });

  it("returns OpenClaw content blocks for discovery store results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ discovery_id: "d-1", category: "gotcha" }),
      }),
    );

    const { default: plugin } = await import("./index.ts");
    const harness = createPluginApiHarness();
    plugin.register?.(harness.api as never);

    const storeTool = harness.tools.find((tool) => tool.name === "knowledgeforge_store_discovery");
    expect(storeTool).toBeDefined();

    const result = await storeTool!.execute("call_3", { content: "Remember this insight" });
    const payload = result as { content?: unknown };
    expect(Array.isArray(payload.content)).toBe(true);
    const blocks = payload.content as Array<{ type?: string; text?: string }>;
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.text).toContain('"discovery_id": "d-1"');
  });

  it("uses plugin config apiUrl when env endpoint is missing", async () => {
    const previousEndpoint = process.env.KNOWLEDGEFORGE_API_URL;
    delete process.env.KNOWLEDGEFORGE_API_URL;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [],
        total_results: 0,
        search_time_ms: 1,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { default: plugin } = await import("./index.ts");
    const harness = createPluginApiHarness({ apiUrl: "http://kf.test:8742/api/v1/" });
    plugin.register?.(harness.api as never);

    const searchTool = harness.tools.find((tool) => tool.name === "knowledgeforge_search");
    expect(searchTool).toBeDefined();
    await searchTool!.execute("call_4", { query: "ping" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://kf.test:8742/api/v1/search",
      expect.objectContaining({ method: "POST" }),
    );

    if (previousEndpoint) {
      process.env.KNOWLEDGEFORGE_API_URL = previousEndpoint;
    } else {
      delete process.env.KNOWLEDGEFORGE_API_URL;
    }
  });
});
