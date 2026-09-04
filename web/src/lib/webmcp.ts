import { boardSeed, type Minesweeper } from "@/lib/minesweeper";
import { api, post, type Game, type ToolDefinition } from "@/lib/api";

type RegisteredTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (input: unknown) => unknown | Promise<unknown>;
};

type ModelContext = { registerTool(tool: RegisteredTool, options?: { signal?: AbortSignal }): void | Promise<void>; unregisterTool?: (name: string) => void };

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContext?: ModelContext;
  }
}

export function createGuestWebMCP({ gameId, guestName, socket, engine, getGame }: { gameId: string; guestName: string; socket: WebSocket; engine: Minesweeper; getGame: () => Game | null }) {
  const registry = new Map<string, RegisteredTool>();
  const nativeContext = document.modelContext?.registerTool ? document.modelContext : navigator.modelContext?.registerTool ? navigator.modelContext : null;
  const nativeRegisterTool = nativeContext?.registerTool.bind(nativeContext) ?? null;
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
  const nativeUnregisterTool = nativeContext?.unregisterTool?.bind(nativeContext) ?? null;

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

  let solved = 0;
  let boardIndex = 0;
  let totalMoves = 0;

  function timeLeftMs() {
    const game = getGame();
    if (!game?.startedAt) return null;
    return game.startedAt + game.durationMs - Date.now();
  }

  function reportCall(toolName: string, input: unknown, result: unknown) {
    return post(`/api/games/${gameId}/guest/${encodeURIComponent(guestName)}/call`, {
      tool: toolName,
      input,
      result,
      status: engine.status === "ready" ? undefined : engine.status,
      moves: totalMoves + engine.moves,
      solved,
      boardIndex,
      board: engine.view(),
    });
  }

  function settleBoard(): string | undefined {
    if (engine.status === "won") {
      solved++;
      return `Board ${boardIndex + 1} solved. Boards solved: ${solved}.`;
    }
    if (engine.status === "lost") return `Mine on board ${boardIndex + 1}. Boards solved: ${solved}.`;
    return undefined;
  }

  function nextBoard() {
    const game = getGame();
    if (!game) return;
    totalMoves += engine.moves;
    boardIndex++;
    const startedAt = engine.startedAt;
    engine.reset(boardSeed(game.seed, boardIndex));
    engine.status = "playing";
    engine.startedAt = startedAt;
  }

  const raceApi = {
    secondsLeft: () => {
      const remaining = timeLeftMs();
      return remaining === null ? null : Math.max(0, Math.round(remaining / 1000));
    },
    boardsSolved: () => solved,
    nextBoard: () => {
      if (engine.status !== "won" && engine.status !== "lost") return { ok: false, error: "current board is still in play" };
      const note = settleBoard();
      void reportCall("next_board", {}, { note, board: engine.text(), ...engine.summary() });
      nextBoard();
      const remaining = timeLeftMs();
      if (remaining !== null && remaining <= 0) return { ok: false, error: "Time is up.", boardsSolved: solved };
      return { ok: true, board: boardIndex + 1, boardsSolved: solved, secondsLeft: raceApi.secondsLeft() };
    },
  };
  Object.assign(engine, raceApi);

  function makeExecute(tool: ToolDefinition) {
    return async (input: unknown) => {
      const game = getGame();
      if (!game?.startedAt) return { ok: false, error: "The race hasn't started yet. Wait for the host." };
      const remaining = timeLeftMs();
      if (remaining !== null && remaining <= 0) return { ok: false, error: "Time is up. The race is over.", solved };
      let result: unknown;
      try {
        const body = new Function("game", "input", tool.code);
        result = await body(engine, input ?? {});
      } catch (error) {
        result = { ok: false, error: `tool ${tool.name} threw: ${(error as Error).message}` };
      }
      const ended = engine.status === "won" || engine.status === "lost";
      const note = ended ? `${settleBoard()} Next board is loaded. Tip: a tool can call game.nextBoard() itself and keep solving boards in one call.` : undefined;
      const output = { ...(typeof result === "object" && result ? result : { result }), ...(note ? { note } : {}), secondsLeft: raceApi.secondsLeft(), boardsSolved: solved };
      await reportCall(tool.name, input, output);
      if (ended) nextBoard();
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
