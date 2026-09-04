import type { Minesweeper } from "@/lib/minesweeper";
import { api, post, type Game, type ToolDefinition } from "@/lib/api";

type RegisteredTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (input: unknown) => unknown | Promise<unknown>;
};

declare global {
  interface Document {
    modelContext?: { registerTool(tool: RegisteredTool, options?: { signal?: AbortSignal }): void | Promise<void> };
  }
}

export function createGuestWebMCP({ gameId, guestName, socket, engine, getGame }: { gameId: string; guestName: string; socket: WebSocket; engine: Minesweeper; getGame: () => Game | null }) {
  const registry = new Map<string, RegisteredTool>();
  const nativeRegisterTool = document.modelContext?.registerTool?.bind(document.modelContext) ?? null;
  const native = !!nativeRegisterTool;
  let registrationAbort: AbortController | null = null;
  let editToolDefinition: { description: string; inputSchema: Record<string, unknown> } | null = null;

  function publishTools() {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "webmcp-tools",
        gameId,
        guest: guestName,
        tools: [...registry.values()].map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations })),
      }),
    );
  }

  const nativelyRegistered = new Set<string>();
  const nativeUnregisterTool = (document.modelContext as { unregisterTool?: (name: string) => void } | undefined)?.unregisterTool?.bind(document.modelContext) ?? null;

  async function registerTool(tool: RegisteredTool, options?: { signal?: AbortSignal }) {
    registry.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => {
      if (registry.get(tool.name) === tool) registry.delete(tool.name);
      publishTools();
    });
    publishTools();
    if (!nativeRegisterTool) return;
    if (nativelyRegistered.has(tool.name)) {
      if (!nativeUnregisterTool) return;
      nativeUnregisterTool(tool.name);
    }
    nativelyRegistered.add(tool.name);
    await nativeRegisterTool({ ...tool, execute: (input: unknown) => (registry.get(tool.name) ?? tool).execute(input) });
  }

  if (!native) document.modelContext = { registerTool };

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "hello", gameId, guest: guestName }));
    publishTools();
  });

  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "webmcp-call") return;
    const tool = registry.get(message.name);
    let result: unknown;
    try {
      result = tool ? await tool.execute(message.input ?? {}) : { ok: false, error: `no WebMCP tool named ${message.name}. Call webmcp_list_tools.` };
    } catch (error) {
      result = { ok: false, error: String((error as Error)?.message || error) };
    }
    socket.send(JSON.stringify({ type: "webmcp-result", id: message.id, result }));
  });

  function reportCall(toolName: string, input: unknown, result: unknown) {
    return post(`/api/games/${gameId}/guest/${encodeURIComponent(guestName)}/call`, {
      tool: toolName,
      input,
      result,
      status: engine.status === "ready" ? undefined : engine.status,
      moves: engine.moves,
      board: engine.view(),
    });
  }

  function makeExecute(tool: ToolDefinition) {
    return async (input: unknown) => {
      let result: unknown;
      try {
        const body = new Function("game", "input", tool.code);
        result = await body(engine, input ?? {});
      } catch (error) {
        result = { ok: false, error: `tool ${tool.name} threw: ${(error as Error).message}` };
      }
      const game = getGame();
      let note: string | undefined;
      if (engine.status === "lost") note = game?.allowRetry ? "You hit a mine. Retries are allowed tonight: the board has been reset to the same layout and the clock is still running." : "You hit a mine. You're out of this race.";
      if (engine.status === "won") note = "You cleared the board!";
      const output = note ? { ...(typeof result === "object" && result ? result : { result }), note } : result;
      await reportCall(tool.name, input, output);
      if (engine.status === "lost" && game?.allowRetry) {
        const startedAt = engine.startedAt;
        engine.reset(game.seed);
        engine.status = "playing";
        engine.startedAt = startedAt;
      }
      return output;
    };
  }

  async function registerAll(tools: ToolDefinition[]) {
    editToolDefinition ??= await api("/api/edit-tool");
    registrationAbort?.abort();
    registrationAbort = new AbortController();
    const definitions: RegisteredTool[] = [
      ...tools.map((tool) => ({ name: tool.name, title: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: tool.name === "look_at_board" }, execute: makeExecute(tool) })),
      {
        name: "edit_tool",
        title: "Edit tool",
        description: editToolDefinition!.description,
        inputSchema: editToolDefinition!.inputSchema,
        annotations: { readOnlyHint: false },
        execute: async (input: unknown) => {
          const saved = await post<{ error?: string; name?: string; memoId?: number }>("/api/tools", { ...(input as object), by: guestName, gameId });
          const output = saved.error
            ? { ok: false, error: saved.error }
            : { ok: true, saved: saved.name, memoId: saved.memoId, note: "Tool is live now for you and every future guest. The tool list changed: call webmcp_list_tools again." };
          await reportCall("edit_tool", input, output);
          return output;
        },
      },
    ];
    for (const definition of definitions) {
      try {
        await registerTool(definition, { signal: registrationAbort.signal });
      } catch (error) {
        console.warn("registerTool failed", definition.name, error);
      }
    }
    return { native, count: definitions.length };
  }

  return { registerAll, native };
}
