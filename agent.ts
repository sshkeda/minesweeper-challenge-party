// Guests: Luna agents driven through your local Codex (app-server protocol) via the Vercel AI SDK.
// Each guest opens the party page in Chrome and plays only through the page's WebMCP tools.
import { streamText } from "ai";
import { createCodexAppServer, createSdkMcpServer, tool, type Session } from "ai-sdk-provider-codex-app-server";
import { z } from "zod";
import { webmcpListTools, webmcpCall, waitForGuestTab } from "./server";

export type GuestEvent =
  | { kind: "session"; threadId: string }
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool-call"; toolName: string; input: unknown; id?: string }
  | { kind: "tool-result"; toolName: string; output: unknown; id?: string }
  | { kind: "heckle"; text: string }
  | { kind: "raw"; data: unknown }
  | { kind: "finish"; reason: string; usage?: unknown }
  | { kind: "error"; message: string };

const sessions = new Map<string, Session>();

export function inviteGuest(opts: {
  gameId: string;
  name: string;
  url: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  onEvent: (ev: GuestEvent) => void;
}) {
  const { gameId, name, url, model, reasoningEffort, onEvent } = opts;

  // The MCP surface mirrors the Codex Chrome plugin's WebMCP API (fetchTools / tools.call), bound to this guest's tab.
  const webmcp = createSdkMcpServer({
    name: "webmcp",
    tools: [
      tool({
        name: "webmcp_list_tools",
        description: `List the WebMCP tools the party page registered with document.modelContext.registerTool() in ${name}'s tab. Call again after edit_tool: the list changes live.`,
        parameters: z.object({}),
        execute: async () => {
          const tools = webmcpListTools(gameId, name);
          if (!tools) return { error: "Your party page is not connected yet. Wait a moment and try again." };
          return { tools };
        },
      }),
      tool({
        name: "webmcp_call_tool",
        description: "Call one of the page's WebMCP tools by name with a JSON input matching its inputSchema. Runs inside the page; returns the tool's result.",
        parameters: z.object({ name: z.string(), input: z.record(z.string(), z.unknown()).optional() }),
        execute: async ({ name: toolName, input }) => webmcpCall(gameId, name, toolName, input ?? {}),
      }),
    ],
  });

  const provider = createCodexAppServer({
    defaultSettings: {
      approvalMode: "never",
      sandboxMode: "danger-full-access",
      reasoningEffort,
      threadMode: "persistent",
      mcpServers: { webmcp },
      onSessionCreated: (s) => {
        sessions.set(name, s);
        onEvent({ kind: "session", threadId: s.threadId });
      },
    },
  });

  // One sentence. The page's tool descriptions do the teaching.
  const prompt = `Beat me at Minesweeper. Your board is already open at ${url}; play only through the page's WebMCP tools (webmcp_list_tools, then webmcp_call_tool) and never click the page. Your name tonight is ${name}.`;

  (async () => {
    try {
      await waitForGuestTab(gameId, name);
      const result = streamText({ model: provider(model), prompt });
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            onEvent({ kind: "text", text: part.text });
            break;
          case "reasoning-delta":
            onEvent({ kind: "reasoning", text: part.text });
            break;
          case "tool-call":
            onEvent({ kind: "tool-call", toolName: part.toolName, input: part.input, id: part.toolCallId });
            break;
          case "tool-result":
            onEvent({ kind: "tool-result", toolName: part.toolName, output: part.output, id: part.toolCallId });
            break;
          case "raw":
            onEvent({ kind: "raw", data: (part as any).rawValue });
            break;
          case "finish":
            onEvent({ kind: "finish", reason: part.finishReason, usage: part.totalUsage });
            break;
          case "error":
            onEvent({ kind: "error", message: String((part as any).error?.message ?? (part as any).error) });
            break;
          default:
            break;
        }
      }
    } catch (e: any) {
      onEvent({ kind: "error", message: String(e?.message ?? e) });
    } finally {
      sessions.delete(name);
    }
  })();
}

export async function heckleGuest(name: string, message: string): Promise<boolean> {
  const s = sessions.get(name);
  if (!s || !s.isActive()) return false;
  await s.injectMessage(message);
  return true;
}
