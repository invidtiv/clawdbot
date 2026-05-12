/**
 * GeminiTTS Plugin for OpenClaw Gateway
 *
 * Provides text-to-speech conversion using Google Gemini 2.5 TTS.
 * Calls the GeminiTTS REST API (Python FastAPI backend).
 *
 * Default API: http://127.0.0.1:8751
 */

const GEMINITTS_API_FALLBACK = "http://127.0.0.1:8751";

type ToolTextResult = {
  content: [{ type: "text"; text: string }];
  details?: unknown;
};

interface VoiceInfo {
  name: string;
  style: string;
}

function normalizeApiBase(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function resolveApiBase(pluginConfig?: Record<string, unknown>): string {
  const envBase = normalizeApiBase(process.env.GEMINITTS_API_URL);
  if (envBase) {
    return envBase;
  }
  const configBase = normalizeApiBase(pluginConfig?.apiUrl);
  return configBase ?? GEMINITTS_API_FALLBACK;
}

function textResult(text: string, details?: unknown): ToolTextResult {
  return details === undefined
    ? { content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }], details };
}

async function fetchVoices(apiBase: string): Promise<VoiceInfo[]> {
  const res = await fetch(`${apiBase}/voices`);
  if (!res.ok) {
    throw new Error(`Failed to fetch voices: ${res.status}`);
  }
  const body = (await res.json()) as { voices: VoiceInfo[] };
  return body.voices;
}

async function ttsFromText(
  apiBase: string,
  text: string,
  voice: string,
  filename?: string,
): Promise<{ path: string; size: number }> {
  const res = await fetch(`${apiBase}/tts/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, filename }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`TTS text failed (${res.status}): ${detail}`);
  }
  // The API returns a WAV file; get content-disposition for filename
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const outName = match?.[1] ?? "output.wav";
  const buf = await res.arrayBuffer();
  // Save to /tmp/geminitts/
  const fs = await import("fs");
  const path = await import("path");
  const outDir = "/tmp/geminitts";
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, Buffer.from(buf));
  return { path: outPath, size: buf.byteLength };
}

async function ttsFromMarkdown(
  apiBase: string,
  mdPath: string,
  voice: string,
  filename?: string,
): Promise<{ path: string; size: number }> {
  const res = await fetch(`${apiBase}/tts/markdown`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ md_path: mdPath, voice, filename }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`TTS markdown failed (${res.status}): ${detail}`);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const outName = match?.[1] ?? "output.wav";
  const buf = await res.arrayBuffer();
  const fs = await import("fs");
  const path = await import("path");
  const outDir = "/tmp/geminitts";
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, Buffer.from(buf));
  return { path: outPath, size: buf.byteLength };
}

async function healthCheck(apiBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default {
  id: "geminitts",
  name: "GeminiTTS",
  description: "Convert text and markdown files to speech using Google Gemini 2.5 TTS",

  register(api: any) {
    const pluginConfig =
      api.pluginConfig && typeof api.pluginConfig === "object"
        ? (api.pluginConfig as Record<string, unknown>)
        : undefined;
    const apiBase = resolveApiBase(pluginConfig);

    // Tool: List voices
    api.registerTool?.({
      label: "List TTS Voices",
      name: "geminitts_list_voices",
      description: "List all available Gemini TTS voices with their style descriptions.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async () => {
        try {
          const voices = await fetchVoices(apiBase);
          const formatted = voices.map((v) => `${v.name} — ${v.style}`).join("\n");
          return textResult(`Available voices (${voices.length}):\n\n${formatted}`, voices);
        } catch (err: any) {
          return textResult(`Error: ${err.message}`);
        }
      },
    });

    // Tool: Convert text to speech
    api.registerTool?.({
      label: "Text to Speech",
      name: "geminitts_text_to_speech",
      description:
        "Convert text to a WAV audio file using Gemini 2.5 TTS. " +
        "Returns the path to the generated WAV file.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to convert to speech" },
          voice: {
            type: "string",
            description:
              "Voice name (default: Kore). Options: Zephyr, Puck, Charon, Kore, Fenrir, Leda, etc.",
          },
          filename: {
            type: "string",
            description: "Custom output filename (optional)",
          },
        },
        required: ["text"],
      },
      execute: async (_toolCallId: string, args: any) => {
        try {
          const result = await ttsFromText(apiBase, args.text, args.voice ?? "Kore", args.filename);
          return textResult(
            `Audio generated: ${result.path} (${(result.size / 1024).toFixed(1)} KB)`,
            result,
          );
        } catch (err: any) {
          return textResult(`Error: ${err.message}`);
        }
      },
    });

    // Tool: Convert markdown file to speech
    api.registerTool?.({
      label: "Markdown to Speech",
      name: "geminitts_markdown_to_speech",
      description:
        "Convert a markdown file to a WAV audio file using Gemini 2.5 TTS. " +
        "Provide the absolute path to a .md file.",
      parameters: {
        type: "object",
        properties: {
          md_path: {
            type: "string",
            description: "Absolute path to the .md file",
          },
          voice: {
            type: "string",
            description: "Voice name (default: Kore)",
          },
          filename: {
            type: "string",
            description: "Custom output filename (optional)",
          },
        },
        required: ["md_path"],
      },
      execute: async (_toolCallId: string, args: any) => {
        try {
          const result = await ttsFromMarkdown(
            apiBase,
            args.md_path,
            args.voice ?? "Kore",
            args.filename,
          );
          return textResult(
            `Audio generated from ${args.md_path}: ${result.path} (${(result.size / 1024).toFixed(1)} KB)`,
            result,
          );
        } catch (err: any) {
          return textResult(`Error: ${err.message}`);
        }
      },
    });

    // Gateway method: health
    api.registerGatewayMethod?.("geminitts.health", async (opts: any) => {
      const healthy = await healthCheck(apiBase);
      opts.respond(true, { healthy, api_url: apiBase });
    });

    // Gateway method: tts
    api.registerGatewayMethod?.("geminitts.convert", async (opts: any) => {
      try {
        const p = opts.params;
        let result;
        if (p.md_path) {
          result = await ttsFromMarkdown(apiBase, p.md_path, p.voice ?? "Kore", p.filename);
        } else if (p.text) {
          result = await ttsFromText(apiBase, p.text, p.voice ?? "Kore", p.filename);
        } else {
          opts.respond(false, undefined, {
            message: "Provide either 'text' or 'md_path'",
          });
          return;
        }
        opts.respond(true, result);
      } catch (err: any) {
        opts.respond(false, undefined, { message: err.message });
      }
    });
  },
};
