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

const sessionsByGuest = new Map<string, Session>();
const abortByGuest = new Map<string, AbortController>();

export function inviteGuest(options: {
  gameId: string;
  name: string;
  url: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  onEvent: (event: GuestEvent) => void;
}) {
  const { gameId, name: guestName, url, model, reasoningEffort, onEvent } = options;

  const webmcpServer = createSdkMcpServer({
    name: "webmcp",
    tools: [
      tool({
        name: "webmcp_list_tools",
        description: `List the WebMCP tools the party page registered with document.modelContext.registerTool() in ${guestName}'s tab. Call again after edit_tool: the list changes live.`,
        parameters: z.object({}),
        execute: async () => {
          const tools = webmcpListTools(gameId, guestName);
          if (!tools) return { error: "Your party page is not connected yet. Wait a moment and try again." };
          return { tools };
        },
      }),
      tool({
        name: "webmcp_call_tool",
        description: "Call one of the page's WebMCP tools by name with a JSON input matching its inputSchema. Runs inside the page; returns the tool's result.",
        parameters: z.object({ name: z.string(), input: z.record(z.string(), z.unknown()).optional() }),
        execute: async ({ name: toolName, input }) => webmcpCall(gameId, guestName, toolName, input ?? {}),
      }),
    ],
  });

  const provider = createCodexAppServer({
    defaultSettings: {
      approvalMode: "never",
      sandboxMode: "danger-full-access",
      reasoningEffort,
      threadMode: "persistent",
      mcpServers: { webmcp: webmcpServer },
      onSessionCreated: (session) => {
        sessionsByGuest.set(guestName, session);
        onEvent({ kind: "session", threadId: session.threadId });
      },
    },
  });

  const prompt = `Beat me at Minesweeper. Your board is already open at ${url}; play only through the page's WebMCP tools (webmcp_list_tools, then webmcp_call_tool) and never click the page. Your name tonight is ${guestName}.`;

  const abort = new AbortController();
  abortByGuest.set(guestName, abort);

  (async () => {
    try {
      const connected = await waitForGuestTab(gameId, guestName);
      if (!connected || abort.signal.aborted) {
        onEvent({ kind: "error", message: "the party page never connected" });
        return;
      }
      const result = streamText({ model: provider(model), prompt, abortSignal: abort.signal });
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
            onEvent({ kind: "raw", data: (part as { rawValue?: unknown }).rawValue });
            break;
          case "finish":
            onEvent({ kind: "finish", reason: part.finishReason, usage: part.totalUsage });
            break;
          case "error": {
            const streamError = (part as { error?: unknown }).error;
            onEvent({ kind: "error", message: String((streamError as Error)?.message ?? streamError) });
            break;
          }
          default:
            break;
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) onEvent({ kind: "error", message: String((error as Error)?.message ?? error) });
    } finally {
      if (abort.signal.aborted) onEvent({ kind: "finish", reason: "page closed" });
      sessionsByGuest.delete(guestName);
      abortByGuest.delete(guestName);
    }
  })();
}

export async function endGuest(guestName: string) {
  const session = sessionsByGuest.get(guestName);
  abortByGuest.get(guestName)?.abort();
  if (session?.isActive()) {
    try {
      await session.interrupt();
    } catch {}
  }
}

export async function heckleGuest(guestName: string, message: string): Promise<boolean> {
  const session = sessionsByGuest.get(guestName);
  if (!session || !session.isActive()) return false;
  await session.injectMessage(message);
  return true;
}
