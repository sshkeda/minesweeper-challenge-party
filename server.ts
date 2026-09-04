import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { inviteGuest, heckleGuest, endGuest, startGuest, type GuestEvent } from "./agent";

const PORT = Number(process.env.PORT ?? 4321);
const APP_URL = process.env.APP_URL ?? "http://localhost:5173";
const ROOT = import.meta.dir;
const GAMES_DIR = join(ROOT, "games");
const TOOL_LOG = "mcp-party-tools";
mkdirSync(GAMES_DIR, { recursive: true });

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  code: string;
  by: string;
  memoId?: number;
  datetime?: string;
  deleted?: boolean;
};

const DEFAULT_TOOLS: ToolDefinition[] = [
  {
    name: "look_at_board",
    description:
      "See your Minesweeper board as text. '#' hidden, 'F' flag, digits are adjacent-mine counts. Also returns status, moves and seconds. Row and col are zero-indexed. The human you are racing plays the same board with a mouse. Every tool on this page can be rewritten with edit_tool, including this one, and your changes stay for every agent after you.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    code: `return { board: game.text(), ...game.summary() };`,
    by: "host",
  },
  {
    name: "reveal_cell",
    description: "Reveal one cell. Hitting a mine loses the race. Returns the updated board.",
    inputSchema: {
      type: "object",
      properties: { row: { type: "integer" }, col: { type: "integer" } },
      required: ["row", "col"],
      additionalProperties: false,
    },
    code: `const result = game.reveal(input.row, input.col); return { ...result, board: game.text(), ...game.summary() };`,
    by: "host",
  },
  {
    name: "flag_cell",
    description: "Toggle a flag on one hidden cell. Returns the updated board.",
    inputSchema: {
      type: "object",
      properties: { row: { type: "integer" }, col: { type: "integer" } },
      required: ["row", "col"],
      additionalProperties: false,
    },
    code: `const result = game.toggleFlag(input.row, input.col); return { ...result, board: game.text(), ...game.summary() };`,
    by: "host",
  },
];

export const EDIT_TOOL: Omit<ToolDefinition, "code"> = {
  name: "edit_tool",
  description:
    "Create or rewrite any tool on this page, for you and every agent after you. Provide name, description, a JSON Schema inputSchema, and code: a JavaScript function body that receives (game, input) and returns a JSON-serializable result. game API: game.rows, game.cols, game.view() -> string[][] of '#', 'F', '*', or digit; game.text() -> printable board; game.reveal(row, col); game.toggleFlag(row, col); game.neighbors(row, col) -> [row, col][]; game.summary(). Takes effect immediately. Example code: 'let revealed = 0; for (const [row, col] of input.cells) { const result = game.reveal(row, col); if (result.hitMine) break; revealed++; } return { revealed, board: game.text(), ...game.summary() };'",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "snake_case tool name" },
      description: { type: "string" },
      inputSchema: { type: "object", description: "JSON Schema for the input" },
      code: { type: "string", description: "JS function body receiving (game, input)" },
    },
    required: ["name", "description", "inputSchema", "code"],
    additionalProperties: false,
  },
  by: "host",
};

async function memo(args: string[]): Promise<string> {
  const memoProcess = Bun.spawn(["memo", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(memoProcess.stdout).text();
  const stderr = await new Response(memoProcess.stderr).text();
  if ((await memoProcess.exited) !== 0) throw new Error(`memo ${args[0]} failed: ${stderr || stdout}`);
  return stdout;
}

type MemoEntry = { id: number; datetime: string; content: string };

function parseMemoLines(output: string): MemoEntry[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MemoEntry)
    .sort((left, right) => left.id - right.id);
}

async function readToolLog(): Promise<MemoEntry[]> {
  try {
    const entries = parseMemoLines(await memo(["search", "--log", TOOL_LOG, "--json", "--full", "--limit", "1000"]));
    const oldestLoadedId = entries[0]?.id ?? 1;
    for (let start = oldestLoadedId - 1; start >= 1; start -= 200) {
      const ids = Array.from({ length: Math.min(200, start) }, (_, offset) => String(start - offset));
      entries.unshift(...parseMemoLines(await memo(["read", ...ids, "--log", TOOL_LOG, "--json"])));
    }
    return entries;
  } catch {
    return [];
  }
}

export async function toolConfig(seedHead?: number, liveEditsAfter?: number) {
  const entries = await readToolLog();
  const toolsByName = new Map<string, ToolDefinition>();
  for (const tool of DEFAULT_TOOLS) toolsByName.set(tool.name, { ...tool, memoId: 0 });
  let head = 0;
  for (const entry of entries) {
    const beyondSeed = seedHead !== undefined && entry.id > seedHead;
    const isLiveEdit = liveEditsAfter !== undefined && entry.id > liveEditsAfter;
    if (beyondSeed && !isLiveEdit) continue;
    head = entry.id;
    try {
      const tool = JSON.parse(entry.content) as ToolDefinition;
      if (tool.deleted) toolsByName.delete(tool.name);
      else toolsByName.set(tool.name, { ...tool, memoId: entry.id, datetime: entry.datetime });
    } catch {}
  }
  return { tools: [...toolsByName.values()], head, entries };
}

export async function writeTool(candidate: ToolDefinition): Promise<ToolDefinition> {
  const name = String(candidate.name ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48);
  if (!name || name === "undefined" || name === "null") throw new Error("name is required (snake_case)");
  if (name === EDIT_TOOL.name) throw new Error("edit_tool cannot be rewritten");
  if (!candidate.deleted && !String(candidate.description ?? "").trim()) throw new Error("description is required");
  if (!candidate.deleted && !String(candidate.code ?? "").trim()) throw new Error("code is required");
  const definition: ToolDefinition = {
    name,
    description: String(candidate.description ?? ""),
    inputSchema: (candidate.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    code: String(candidate.code ?? ""),
    by: String(candidate.by ?? "agent").slice(0, 64),
    deleted: !!candidate.deleted,
  };
  if (!definition.deleted) new Function("game", "input", definition.code);
  const output = await memo(["append", "--log", TOOL_LOG, "--json", JSON.stringify(definition)]);
  const { id, datetime } = JSON.parse(output.trim().split("\n").pop()!);
  const saved = { ...definition, memoId: id, datetime };
  broadcast({ type: "tools", ...(await toolConfig()) });
  return saved;
}

export type Guest = {
  name: string;
  hat: string;
  status: "arriving" | "ready" | "playing" | "won" | "lost" | "left" | "error";
  threadId?: string;
  startedAt?: number;
  endedAt?: number;
  moves: number;
  toolCalls: number;
  toolsEdited: number;
  retries: number;
  error?: string;
};

export type HumanState = {
  status: "ready" | "playing" | "won" | "lost" | "spectating";
  startedAt?: number;
  endedAt?: number;
  moves: number;
  retries: number;
};

export type Game = {
  id: string;
  createdAt: number;
  rows: number;
  cols: number;
  mines: number;
  seed: number;
  toolHead: number;
  startHead: number;
  allowRetry: boolean;
  spectate: boolean;
  startedAt?: number;
  guests: Record<string, Guest>;
  human: HumanState;
  winner?: "human" | string | "nobody";
};

const games = new Map<string, Game>();
const gameDir = (gameId: string) => join(GAMES_DIR, gameId);

function saveGame(game: Game) {
  mkdirSync(join(gameDir(game.id), "guests"), { recursive: true });
  writeFileSync(join(gameDir(game.id), "game.json"), JSON.stringify(game, null, 2));
}

function loadGames() {
  if (!existsSync(GAMES_DIR)) return;
  for (const gameId of readdirSync(GAMES_DIR)) {
    const file = join(GAMES_DIR, gameId, "game.json");
    if (!existsSync(file)) continue;
    try {
      const game = JSON.parse(readFileSync(file, "utf8")) as Game;
      for (const guest of Object.values(game.guests)) {
        if (guest.status === "arriving" || guest.status === "ready" || guest.status === "playing") guest.status = "left";
      }
      games.set(gameId, game);
    } catch {}
  }
}
loadGames();

const lastGame = () => [...games.values()].sort((left, right) => right.createdAt - left.createdAt)[0];

function appendTranscript(gameId: string, guestName: string, event: GuestEvent) {
  mkdirSync(join(gameDir(gameId), "guests"), { recursive: true });
  appendFileSync(join(gameDir(gameId), "guests", `${guestName}.jsonl`), JSON.stringify({ t: Date.now(), ...event }) + "\n");
}

function appendToolLog(gameId: string, record: Record<string, unknown>) {
  appendFileSync(join(gameDir(gameId), "tool-calls.jsonl"), JSON.stringify({ t: Date.now(), ...record }) + "\n");
}

function settleWinner(game: Game) {
  if (game.winner) return;
  const isFinished = (status: string) => status === "won" || status === "lost";
  const guests = Object.values(game.guests);
  const humanDone = game.spectate || isFinished(game.human.status);
  const guestsDone =
    guests.length > 0 && guests.every((guest) => isFinished(guest.status) || guest.status === "left" || guest.status === "error");
  const finishers: { who: string; at: number }[] = [];
  if (game.human.status === "won") finishers.push({ who: "human", at: game.human.endedAt! });
  for (const guest of guests) if (guest.status === "won") finishers.push({ who: guest.name, at: guest.endedAt! });

  if (finishers.length) {
    const someoneStillPlaying =
      guests.some((guest) => guest.status === "playing" || guest.status === "arriving" || guest.status === "ready") || game.human.status === "playing";
    if ((!humanDone || !guestsDone) && someoneStillPlaying) return;
    finishers.sort((left, right) => left.at - right.at);
    game.winner = finishers[0].who;
  } else if (humanDone && guestsDone) {
    game.winner = "nobody";
  }

  if (game.winner) {
    saveGame(game);
    broadcast({ type: "winner", gameId: game.id, winner: game.winner });
  }
}

type PartySocket = import("bun").ServerWebSocket<{ gameId?: string }>;
const sockets = new Set<PartySocket>();

function broadcast(message: unknown) {
  const serialized = JSON.stringify(message);
  for (const socket of sockets) socket.send(serialized);
}

type PublishedTool = { name: string; title?: string; description: string; inputSchema: unknown; annotations?: unknown };
const guestTabs = new Map<string, { socket: PartySocket; tools: PublishedTool[] }>();
const pendingCalls = new Map<string, { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
const guestTabKey = (gameId: string, guestName: string) => `${gameId}/${guestName}`;

export function webmcpListTools(gameId: string, guestName: string): PublishedTool[] | null {
  return guestTabs.get(guestTabKey(gameId, guestName))?.tools ?? null;
}

export function webmcpCall(gameId: string, guestName: string, toolName: string, input: unknown): Promise<unknown> {
  const tab = guestTabs.get(guestTabKey(gameId, guestName));
  if (!tab) return Promise.resolve({ ok: false, error: "Your party page is not open. Ask the host." });
  const callId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      resolve({ ok: false, error: "tool call timed out" });
    }, 30_000);
    pendingCalls.set(callId, { resolve, timer });
    tab.socket.send(JSON.stringify({ type: "webmcp-call", id: callId, name: toolName, input }));
  });
}

export async function waitForGuestTab(gameId: string, guestName: string, timeoutMs = 15_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (guestTabs.has(guestTabKey(gameId, guestName))) return true;
    await Bun.sleep(150);
  }
  return false;
}

const PARTY_NAMES = ["Luna", "Nova", "Pixel", "Bolt", "Mochi", "Zippy", "Biscuit", "Comet", "Pebble", "Sprocket", "Waffles", "Gizmo"];
const HATS = ["🎩", "🥳", "🎉", "👑", "🪩", "🎈", "🧢", "🎀", "🦄", "🪅", "🍕", "🎂"];

async function readJson(request: Request) {
  try {
    return (await request.json()) as any;
  } catch {
    return {};
  }
}
const respond = (body: unknown, status = 200) => Response.json(body, { status });

function readJsonl(file: string) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const server = Bun.serve<{ gameId?: string }>({
  port: PORT,
  routes: {
    "/": () => Response.redirect(APP_URL, 302),
    "/api/health": () => respond({ ok: true, party: "Minesweeper Challenge Party" }),
    "/api/edit-tool": () => respond(EDIT_TOOL),

    "/api/tools": {
      GET: async (request) => {
        const url = new URL(request.url);
        const gameId = url.searchParams.get("game");
        if (gameId && games.has(gameId)) {
          const game = games.get(gameId)!;
          return respond(await toolConfig(game.toolHead, game.startHead));
        }
        const upTo = url.searchParams.get("upTo");
        return respond(await toolConfig(upTo ? Number(upTo) : undefined));
      },
      POST: async (request) => {
        const body = await readJson(request);
        try {
          const saved = await writeTool({ ...body, by: body.by || "host" });
          if (body.gameId) appendToolLog(body.gameId, { kind: "edit_tool", by: saved.by, tool: saved.name, memoId: saved.memoId });
          return respond(saved, 201);
        } catch (error) {
          return respond({ error: String((error as Error).message || error) }, 400);
        }
      },
    },

    "/api/games": {
      GET: () => respond([...games.values()].sort((left, right) => right.createdAt - left.createdAt)),
      POST: async (request) => {
        const body = await readJson(request);
        const previous = lastGame();
        const reusePrevious = !!body.useLast && previous;
        const seedHead = body.toolHead !== undefined && body.toolHead !== "" ? Number(body.toolHead) : undefined;
        const config = await toolConfig(seedHead);
        const rows = Math.max(4, Math.min(30, Number(reusePrevious ? previous!.rows : body.rows ?? 9)));
        const cols = Math.max(4, Math.min(40, Number(reusePrevious ? previous!.cols : body.cols ?? 9)));
        const maxMines = rows * cols - 9;
        const mines = Math.max(1, Math.min(maxMines, Number(reusePrevious ? previous!.mines : body.mines ?? Math.round(rows * cols * 0.12))));
        const keepBoard = reusePrevious && !body.newBoard;
        const spectate = !!body.spectate;
        const game: Game = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          createdAt: Date.now(),
          rows,
          cols,
          mines,
          seed: keepBoard ? previous!.seed : Number(body.seed) || Math.floor(Math.random() * 2 ** 31),
          toolHead: config.head,
          startHead: (await toolConfig()).head,
          allowRetry: !!body.allowRetry,
          spectate,
          guests: {},
          human: { status: spectate ? "spectating" : "ready", moves: 0, retries: 0 },
        };
        games.set(game.id, game);
        saveGame(game);
        broadcast({ type: "game", game });
        return respond(game, 201);
      },
    },

    "/api/games/:id": {
      GET: (request) => {
        const game = games.get(request.params.id);
        return game ? respond(game) : respond({ error: "no such game" }, 404);
      },
    },

    "/api/games/:id/human": {
      POST: async (request) => {
        const game = games.get(request.params.id);
        if (!game) return respond({ error: "no such game" }, 404);
        Object.assign(game.human, await readJson(request));
        saveGame(game);
        broadcast({ type: "human", gameId: game.id, human: game.human });
        settleWinner(game);
        return respond(game.human);
      },
    },

    "/api/games/:id/guest/:guest/call": {
      POST: async (request) => {
        const game = games.get(request.params.id);
        if (!game) return respond({ error: "no such game" }, 404);
        const guest = game.guests[request.params.guest];
        const body = await readJson(request);
        appendToolLog(game.id, { kind: "tool_call", guest: request.params.guest, tool: body.tool, input: body.input, result: body.result });
        if (guest) {
          guest.toolCalls++;
          if (body.tool === "edit_tool") guest.toolsEdited++;
          if (body.status) {
            if (guest.status === "arriving" || guest.status === "ready") {
              guest.status = "playing";
              guest.startedAt = Date.now();
            }
            if (body.status === "won" || body.status === "lost") {
              if (body.status === "lost" && game.allowRetry) guest.retries++;
              else {
                guest.status = body.status;
                guest.endedAt = Date.now();
              }
            }
          }
          if (typeof body.moves === "number") guest.moves = body.moves;
          saveGame(game);
          broadcast({ type: "guest", gameId: game.id, guest, board: body.board });
          settleWinner(game);
        }
        return respond({ ok: true });
      },
    },

    "/api/games/:id/invite": {
      POST: async (request) => {
        const game = games.get(request.params.id);
        if (!game) return respond({ error: "no such game" }, 404);
        const body = await readJson(request);
        const count = Math.max(1, Math.min(8, Number(body.count ?? 1)));
        const invited: Guest[] = [];
        for (let index = 0; index < count; index++) {
          const guestNumber = Object.keys(game.guests).length;
          const guestName = `${PARTY_NAMES[guestNumber % PARTY_NAMES.length]}-${guestNumber + 1}`;
          const guest: Guest = {
            name: guestName,
            hat: HATS[guestNumber % HATS.length],
            status: "arriving",
            moves: 0,
            toolCalls: 0,
            toolsEdited: 0,
            retries: 0,
          };
          game.guests[guestName] = guest;
          invited.push(guest);
          const url = `${APP_URL}/?game=${game.id}&guest=${encodeURIComponent(guestName)}`;
          waitForGuestTab(game.id, guestName).then((connected) => {
            if (!connected) appendTranscript(game.id, guestName, { kind: "error", message: "guest tab never connected" });
          });
          inviteGuest({
            gameId: game.id,
            name: guestName,
            url,
            model: body.model || "gpt-5.6-luna",
            reasoningEffort: body.reasoningEffort || "low",
            onEvent: (event) => {
              appendTranscript(game.id, guestName, event);
              broadcast({ type: "chatter", gameId: game.id, guest: guestName, ev: event });
              if (event.kind === "session") {
                guest.threadId = event.threadId;
                saveGame(game);
              }
              if (event.kind === "joined") {
                guest.status = "ready";
                saveGame(game);
                broadcast({ type: "guest", gameId: game.id, guest });
              }
              if (event.kind === "finish") {
                if (guest.status === "arriving" || guest.status === "ready" || guest.status === "playing") guest.status = "left";
                guest.endedAt ??= Date.now();
                saveGame(game);
                broadcast({ type: "guest", gameId: game.id, guest });
                settleWinner(game);
              }
              if (event.kind === "error") {
                guest.status = "error";
                guest.error = event.message;
                guest.endedAt = Date.now();
                saveGame(game);
                broadcast({ type: "guest", gameId: game.id, guest });
                settleWinner(game);
              }
            },
          });
        }
        saveGame(game);
        broadcast({ type: "game", game });
        return respond(invited, 201);
      },
    },

    "/api/games/:id/start": {
      POST: async (request) => {
        const game = games.get(request.params.id);
        if (!game) return respond({ error: "no such game" }, 404);
        if (!game.startedAt) {
          game.startedAt = Date.now();
          saveGame(game);
          for (const guestName of Object.keys(game.guests)) startGuest(guestName);
          broadcast({ type: "started", gameId: game.id, startedAt: game.startedAt });
        }
        return respond(game);
      },
    },

    "/api/games/:id/guest/:guest/heckle": {
      POST: async (request) => {
        const body = await readJson(request);
        const message = String(body.message || "You're losing to a human, you know.");
        const sent = await heckleGuest(request.params.guest, message);
        if (sent) appendTranscript(request.params.id, request.params.guest, { kind: "heckle", text: message });
        return respond({ sent });
      },
    },

    "/api/games/:id/transcript/:guest": {
      GET: (request) => respond(readJsonl(join(gameDir(request.params.id), "guests", `${request.params.guest}.jsonl`))),
    },

    "/api/games/:id/tool-calls": {
      GET: (request) => respond(readJsonl(join(gameDir(request.params.id), "tool-calls.jsonl"))),
    },
  },

  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(request, { data: {} })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(socket) {
      sockets.add(socket);
    },
    close(socket) {
      sockets.delete(socket);
      for (const [key, tab] of guestTabs) {
        if (tab.socket !== socket) continue;
        guestTabs.delete(key);
        const [gameId, guestName] = key.split("/");
        endGuest(guestName);
        const game = games.get(gameId);
        const guest = game?.guests[guestName];
        if (game && guest && (guest.status === "arriving" || guest.status === "ready" || guest.status === "playing")) {
          guest.status = "left";
          guest.endedAt = Date.now();
          saveGame(game);
          broadcast({ type: "guest", gameId, guest });
          settleWinner(game);
        }
      }
    },
    message(socket, raw) {
      let message: any;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.type === "hello" && message.gameId && message.guest) {
        guestTabs.set(guestTabKey(message.gameId, message.guest), { socket, tools: [] });
      }
      if (message.type === "webmcp-tools" && message.gameId && message.guest) {
        guestTabs.set(guestTabKey(message.gameId, message.guest), { socket, tools: message.tools ?? [] });
      }
      if (message.type === "webmcp-result" && message.id) {
        const pending = pendingCalls.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCalls.delete(message.id);
          pending.resolve(message.result);
        }
      }
    },
  },
});

console.log(`🎉 Minesweeper Challenge Party at http://localhost:${server.port}`);
