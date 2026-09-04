import { streamText } from "ai";
import { createCodexAppServer, type Session } from "ai-sdk-provider-codex-app-server";

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
const startersByGuest = new Map<string, () => Promise<void>>();
const endersByGuest = new Map<string, () => Promise<void>>();

export function inviteGuest(options: {
  name: string;
  url: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  onEvent: (event: GuestEvent) => void;
}) {
  const { name: guestName, url, model, reasoningEffort, onEvent } = options;

  const provider = createCodexAppServer({
    defaultSettings: {
      approvalMode: "never",
      sandboxMode: "danger-full-access",
      reasoningEffort,
      threadMode: "persistent",
      onSessionCreated: (session) => {
        sessionsByGuest.set(guestName, session);
        onEvent({ kind: "session", threadId: session.threadId });
      },
    },
  });

  const invitePrompt = `You're invited to a Minesweeper race. Open ${url} in Chrome. The page exposes WebMCP tools; call its ready_up tool when you're in, then stop.`;
  const startPrompt = `Beat me at Minesweeper. Use the page's tools—and improve them if you need to.`;

  const abort = new AbortController();
  const languageModel = provider(model);

  let started = false;
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

  const inviteTurn = runTurn(invitePrompt).catch((error) => {
    if (!abort.signal.aborted) onEvent({ kind: "error", message: String((error as Error)?.message ?? error) });
  });

  startersByGuest.set(guestName, async () => {
    if (started || abort.signal.aborted) return;
    started = true;
    try {
      await inviteTurn;
      if (abort.signal.aborted) return;
      await runTurn(startPrompt);
    } catch (error) {
      if (!abort.signal.aborted) onEvent({ kind: "error", message: String((error as Error)?.message ?? error) });
    } finally {
      if (abort.signal.aborted) onEvent({ kind: "finish", reason: "page closed" });
      sessionsByGuest.delete(guestName);
    }
  });

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
