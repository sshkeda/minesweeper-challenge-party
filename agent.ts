import { streamText } from "ai";
import { createCodexAppServer, createSdkMcpServer, tool, type Session } from "ai-sdk-provider-codex-app-server";
import { z } from "zod";
import { webmcpListTools, webmcpCall, waitForGuestTab } from "./server";

export type GuestEvent =
  | { kind: "session"; threadId: string }
  | { kind: "joined" }
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
const startersByGuest = new Map<string, () => Promise<void>>();
const endersByGuest = new Map<string, () => Promise<void>>();

export function inviteGuest(options: {
  gameId: string;
  name: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  onEvent: (event: GuestEvent) => void;
}) {
  const { gameId, name: guestName, model, reasoningEffort, onEvent } = options;

  let readyResolve: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });

  const webmcpServer = createSdkMcpServer({
    name: "webmcp",
    tools: [
      tool({
        name: "ready_up",
        description: "Tell the host you have joined and are ready to race. Call this once, after webmcp_list_tools, before the race starts.",
        parameters: z.object({}),
        execute: async () => {
          readyResolve?.();
          return { ok: true, message: "You're in. Wait for the host to start the race." };
        },
      }),
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

  const systemPrompt = `You are ${guestName}, a competitive Minesweeper racer at the Minesweeper Challenge Party. You are racing a human on identical boards. Score = boards solved before the clock runs out. Nothing else counts.

How to win:
- Speed is everything. Every call costs seconds. Never narrate, never explain, never pause to think between moves. Act.
- The game page gives you tools through webmcp_list_tools / webmcp_call_tool. Use the most powerful tool available. If a tool solves a whole board in one call, call it again and again. Do not fall back to one-cell digs when a solver exists.
- If no solver tool exists yet, or the existing ones are weak, build one immediately with edit_tool: a JavaScript function body that receives (game, input), runs constraint deduction plus a guess when stuck, and keeps going until game.summary().status is "won" or "lost". Then use it every turn. Tools you build persist for future racers, so make them good.
- A board ending (solved or mine) loads the next board automatically. Do not stop. Call your solver again right away. Stop only when a tool result says time is up.
- Never open a browser or use computer-use tools. The webmcp tools are the whole game.`;

  const provider = createCodexAppServer({
    defaultSettings: {
      baseInstructions: systemPrompt,
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

  const invitePrompt = `You're invited. Call webmcp_list_tools to see your tools, then call ready_up, then say hi in one short sentence and stop. Do not play yet.`;
  const startPrompt = `GO. Solve as many boards as you can before time runs out. Use your fastest solver on every call, build a better one with edit_tool if needed, and never stop between boards. Do not write any text until a tool result says time is up; then report your score in one line.`;

  const abort = new AbortController();
  abortByGuest.set(guestName, abort);
  const languageModel = provider(model);

  let turnActive = false;
  const runTurn = async (prompt: string) => {
    turnActive = true;
    try {
      const result = streamText({ model: languageModel, prompt, abortSignal: abort.signal });
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
            if (started) onEvent({ kind: "finish", reason: part.finishReason, usage: part.totalUsage });
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
    } finally {
      turnActive = false;
    }
  };

  let started = false;
  let inviteTurn: Promise<void> = Promise.resolve();
  const startRace = async () => {
    if (started || abort.signal.aborted) return;
    started = true;
    try {
      await inviteTurn.catch(() => {});
      if (abort.signal.aborted) return;
      await runTurn(startPrompt);
    } catch (error) {
      if (!abort.signal.aborted) onEvent({ kind: "error", message: String((error as Error)?.message ?? error) });
    } finally {
      if (abort.signal.aborted) onEvent({ kind: "finish", reason: "page closed" });
      sessionsByGuest.delete(guestName);
      abortByGuest.delete(guestName);
    }
  };
  startersByGuest.set(guestName, startRace);
  endersByGuest.set(guestName, async () => {
    startersByGuest.delete(guestName);
    if (turnActive) abort.abort();
    const session = sessionsByGuest.get(guestName);
    if (session?.isActive()) {
      try {
        await session.interrupt();
      } catch {}
    }
    sessionsByGuest.delete(guestName);
  });

  (async () => {
    try {
      const connected = await waitForGuestTab(gameId, guestName);
      if (!connected || abort.signal.aborted) {
        onEvent({ kind: "error", message: "the party page never connected" });
        return;
      }
      inviteTurn = runTurn(invitePrompt);
      await Promise.race([ready, inviteTurn]);
      onEvent({ kind: "joined" });
      await inviteTurn;
    } catch (error) {
      if (!abort.signal.aborted) onEvent({ kind: "error", message: String((error as Error)?.message ?? error) });
    }
  })();
}

export function startGuest(guestName: string) {
  return startersByGuest.get(guestName)?.();
}

export async function endGuest(guestName: string) {
  const ender = endersByGuest.get(guestName);
  endersByGuest.delete(guestName);
  await ender?.();
}

export async function heckleGuest(guestName: string, message: string): Promise<boolean> {
  const session = sessionsByGuest.get(guestName);
  if (!session || !session.isActive()) return false;
  await session.injectMessage(message);
  return true;
}
