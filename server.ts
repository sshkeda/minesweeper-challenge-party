// Minesweeper Challenge Party — one Bun server. You host, Luna agents are guests.
// Run: bun --hot server.ts
import index from "./index.html";
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { inviteGuest, heckleGuest, type GuestEvent } from "./agent";

const PORT = Number(process.env.PORT ?? 4321);
const ROOT = import.meta.dir;
const GAMES = join(ROOT, "games");
const TOOL_LOG = "mcp-party-tools"; // memo named log holding every tool version ever written
mkdirSync(GAMES, { recursive: true });

// ---------- Tools: source of truth is memo. Config = replay of the log, latest per name wins. ----------
export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  code: string; // JS function body: (game, input) => result
  by: string;
  memoId?: number;
  datetime?: string;
  deleted?: boolean;
};

const DEFAULT_TOOLS: ToolDef[] = [
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
    code: `const r = game.reveal(input.row, input.col); return { ...r, board: game.text(), ...game.summary() };`,
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
    code: `const r = game.toggleFlag(input.row, input.col); return { ...r, board: game.text(), ...game.summary() };`,
    by: "host",
  },
];

// edit_tool is the only tool agents cannot rewrite. It lives here, not in memo.
export const EDIT_TOOL: Omit<ToolDef, "code"> = {
  name: "edit_tool",
  description:
    "Create or rewrite any tool on this page, for you and every agent after you. Provide name, description, a JSON Schema inputSchema, and code: a JavaScript function body that receives (game, input) and returns a JSON-serializable result. game API: game.rows, game.cols, game.view() -> string[][] of '#', 'F', '*', or digit; game.text() -> printable board; game.reveal(row, col); game.toggleFlag(row, col); game.neighbors(row, col) -> [row, col][]; game.summary(). Take effect immediately. Example code: 'let n=0; for (const [r,c] of input.cells) { const x = game.reveal(r,c); if (x.hitMine) break; n++; } return { revealed: n, board: game.text(), ...game.summary() };'",
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
  const p = Bun.spawn(["memo", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`memo ${args[0]} failed: ${err || out}`);
  return out;
}

type MemoEntry = { id: number; datetime: string; content: string };
async function readToolLog(): Promise<MemoEntry[]> {
  try {
    // memo caps --limit at 1000 (newest first). Grab the newest 1000, then backfill older ids with `read`.
    const out = await memo(["search", "--log", TOOL_LOG, "--json", "--full", "--limit", "1000"]);
    const rows = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as MemoEntry).sort((a, b) => a.id - b.id);
    const oldest = rows[0]?.id ?? 1;
    for (let start = oldest - 1; start >= 1; start -= 200) {
      const ids = Array.from({ length: Math.min(200, start) }, (_, i) => String(start - i));
      const more = await memo(["read", ...ids, "--log", TOOL_LOG, "--json"]);
      rows.unshift(...more.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as MemoEntry).sort((a, b) => a.id - b.id));
    }
    return rows;
  } catch {
    return [];
  }
}

/** Replay the memo log up to `upTo` (inclusive memo id). Returns the tool config at that point. */
export async function toolConfig(upTo?: number, sinceExclusive?: number): Promise<{ tools: ToolDef[]; head: number; entries: MemoEntry[] }> {
  const entries = await readToolLog();
  const map = new Map<string, ToolDef>();
  for (const t of DEFAULT_TOOLS) map.set(t.name, { ...t, memoId: 0 });
  let head = 0;
  for (const e of entries) {
    // Seeded games: replay up to the seed, skip the gap, then include anything written after the game began.
    if (upTo !== undefined && e.id > upTo && !(sinceExclusive !== undefined && e.id > sinceExclusive)) continue;
    head = e.id;
    try {
      const t = JSON.parse(e.content) as ToolDef;
      if (t.deleted) map.delete(t.name);
      else map.set(t.name, { ...t, memoId: e.id, datetime: e.datetime });
    } catch {}
  }
  return { tools: [...map.values()], head, entries };
}

export async function writeTool(t: ToolDef): Promise<ToolDef> {
  const name = String(t.name).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48);
  if (name === EDIT_TOOL.name) throw new Error("edit_tool cannot be rewritten");
  const def: ToolDef = {
    name,
    description: String(t.description ?? ""),
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    code: String(t.code ?? ""),
    by: String(t.by ?? "agent").slice(0, 64),
    deleted: !!t.deleted,
  };
  // Smoke-compile so a syntax error never lands in the log.
  if (!def.deleted) new Function("game", "input", def.code);
  const out = await memo(["append", "--log", TOOL_LOG, "--json", JSON.stringify(def)]);
  const { id, datetime } = JSON.parse(out.trim().split("\n").pop()!);
  const saved = { ...def, memoId: id, datetime };
  broadcast({ type: "tools", ...(await toolConfig()) });
  return saved;
}

// ---------- Games ----------
export type Guest = {
  name: string;
  hat: string;
  status: "arriving" | "playing" | "won" | "lost" | "left" | "error";
  threadId?: string;
  startedAt?: number;
  endedAt?: number;
  moves: number;
  toolCalls: number;
  toolsEdited: number;
  retries: number;
  error?: string;
};
export type Game = {
  id: string;
  createdAt: number;
  rows: number;
  cols: number;
  mines: number;
  seed: number;
  toolHead: number; // memo id the tool config was seeded from
  startHead: number; // memo head when the game was created; later entries are live edits for this game
  allowRetry: boolean;
  guests: Record<string, Guest>;
  human: { status: "ready" | "playing" | "won" | "lost"; startedAt?: number; endedAt?: number; moves: number; retries: number };
  winner?: "human" | string | "nobody";
};

const games = new Map<string, Game>();
const gameDir = (id: string) => join(GAMES, id);
function saveGame(g: Game) {
  mkdirSync(join(gameDir(g.id), "guests"), { recursive: true });
  writeFileSync(join(gameDir(g.id), "game.json"), JSON.stringify(g, null, 2));
}
function loadGames() {
  if (!existsSync(GAMES)) return;
  for (const id of readdirSync(GAMES)) {
    const f = join(GAMES, id, "game.json");
    if (existsSync(f)) {
      try {
        const g = JSON.parse(readFileSync(f, "utf8")) as Game;
        for (const gu of Object.values(g.guests)) if (gu.status === "arriving" || gu.status === "playing") gu.status = "left";
        games.set(id, g);
      } catch {}
    }
  }
}
loadGames();
const lastGame = () => [...games.values()].sort((a, b) => b.createdAt - a.createdAt)[0];

function appendTranscript(gameId: string, guest: string, ev: GuestEvent) {
  mkdirSync(join(gameDir(gameId), "guests"), { recursive: true });
  appendFileSync(join(gameDir(gameId), "guests", `${guest}.jsonl`), JSON.stringify({ t: Date.now(), ...ev }) + "\n");
}
function toolLog(gameId: string, line: Record<string, unknown>) {
  appendFileSync(join(gameDir(gameId), "tool-calls.jsonl"), JSON.stringify({ t: Date.now(), ...line }) + "\n");
}

function settleWinner(g: Game) {
  if (g.winner) return;
  const finished = (s: string) => s === "won" || s === "lost";
  const guests = Object.values(g.guests);
  const humanDone = finished(g.human.status);
  const guestsDone = guests.length > 0 && guests.every((x) => finished(x.status) || x.status === "left" || x.status === "error");
  const wins: { who: string; at: number }[] = [];
  if (g.human.status === "won") wins.push({ who: "human", at: g.human.endedAt! });
  for (const x of guests) if (x.status === "won") wins.push({ who: x.name, at: x.endedAt! });
  if (wins.length) {
    // First to finish wins. If the human has won and a guest is still playing, wait; a guest could have started earlier.
    if (!humanDone || !guestsDone) {
      const stillPlaying = guests.some((x) => x.status === "playing" || x.status === "arriving") || g.human.status === "playing";
      if (stillPlaying) return;
    }
    wins.sort((a, b) => a.at - b.at);
    g.winner = wins[0].who;
  } else if (humanDone && guestsDone) g.winner = "nobody";
  if (g.winner) {
    saveGame(g);
    broadcast({ type: "winner", gameId: g.id, winner: g.winner });
  }
}

// ---------- WebSocket fan-out ----------
type WS = import("bun").ServerWebSocket<{ gameId?: string }>;
const sockets = new Set<WS>();
function broadcast(msg: unknown) {
  const s = JSON.stringify(msg);
  for (const ws of sockets) ws.send(s);
}

// ---------- WebMCP bridge: each guest tab publishes the tools it registered via document.modelContext.
// Codex reaches those exact registrations through an MCP server (agent.ts) that calls into the tab here. ----------
type PublishedTool = { name: string; title?: string; description: string; inputSchema: unknown; annotations?: unknown };
const guestTabs = new Map<string, { ws: WS; tools: PublishedTool[] }>(); // key: `${gameId}/${guest}`
const pending = new Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
export function webmcpListTools(gameId: string, guest: string): PublishedTool[] | null {
  return guestTabs.get(`${gameId}/${guest}`)?.tools ?? null;
}
export function webmcpCall(gameId: string, guest: string, name: string, input: unknown): Promise<unknown> {
  const tab = guestTabs.get(`${gameId}/${guest}`);
  if (!tab) return Promise.resolve({ ok: false, error: "Your party page is not open. Ask the host." });
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "tool call timed out" }); }, 30_000);
    pending.set(id, { resolve, timer });
    tab.ws.send(JSON.stringify({ type: "webmcp-call", id, name, input }));
  });
}
export async function waitForGuestTab(gameId: string, guest: string, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (guestTabs.has(`${gameId}/${guest}`)) return true; await Bun.sleep(150); }
  return false;
}

const PARTY_NAMES = ["Luna", "Nova", "Pixel", "Bolt", "Mochi", "Zippy", "Biscuit", "Comet", "Pebble", "Sprocket", "Waffles", "Gizmo"];
const HATS = ["🎩", "🥳", "🎉", "👑", "🪩", "🎈", "🧢", "🎀", "🦄", "🪅", "🍕", "🎂"];

async function json(req: Request) {
  try { return (await req.json()) as any; } catch { return {}; }
}
const ok = (b: unknown, status = 200) => Response.json(b, { status });

const server = Bun.serve<{ gameId?: string }>({
  port: PORT,
  development: { hmr: true, console: true },
  routes: {
    "/": index,
    "/api/health": () => ok({ ok: true, party: "Minesweeper Challenge Party" }),
    "/api/edit-tool": () => ok(EDIT_TOOL),

    "/api/tools": {
      GET: async (req) => {
        const url = new URL(req.url);
        const gameId = url.searchParams.get("game");
        if (gameId && games.has(gameId)) {
          const g = games.get(gameId)!;
          return ok(await toolConfig(g.toolHead, g.startHead));
        }
        const upTo = url.searchParams.get("upTo");
        return ok(await toolConfig(upTo ? Number(upTo) : undefined));
      },
      POST: async (req) => {
        const body = await json(req);
        try {
          const saved = await writeTool({ ...body, by: body.by || "host" });
          if (body.gameId) toolLog(body.gameId, { kind: "edit_tool", by: saved.by, tool: saved.name, memoId: saved.memoId });
          return ok(saved, 201);
        } catch (e: any) { return ok({ error: String(e.message || e) }, 400); }
      },
    },

    "/api/games": {
      GET: () => ok([...games.values()].sort((a, b) => b.createdAt - a.createdAt)),
      POST: async (req) => {
        const body = await json(req);
        const last = lastGame();
        const useLast = !!body.useLast && last;
        const cfg = await toolConfig(body.toolHead !== undefined && body.toolHead !== "" ? Number(body.toolHead) : undefined);
        const rows = Math.max(4, Math.min(30, Number(useLast ? last!.rows : body.rows ?? 9)));
        const cols = Math.max(4, Math.min(40, Number(useLast ? last!.cols : body.cols ?? 9)));
        const maxMines = rows * cols - 9;
        const mines = Math.max(1, Math.min(maxMines, Number(useLast ? last!.mines : body.mines ?? Math.round(rows * cols * 0.12))));
        const g: Game = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          createdAt: Date.now(),
          rows, cols, mines,
          seed: useLast ? last!.seed : Number(body.seed) || Math.floor(Math.random() * 2 ** 31),
          toolHead: cfg.head,
          startHead: (await toolConfig()).head,
          allowRetry: !!body.allowRetry,
          guests: {},
          human: { status: "ready", moves: 0, retries: 0 },
        };
        games.set(g.id, g);
        saveGame(g);
        broadcast({ type: "game", game: g });
        return ok(g, 201);
      },
    },
    "/api/games/:id": {
      GET: (req) => {
        const g = games.get(req.params.id);
        return g ? ok(g) : ok({ error: "no such game" }, 404);
      },
    },
    // Human side reports its progress (the human plays in the browser; the server only records).
    "/api/games/:id/human": {
      POST: async (req) => {
        const g = games.get(req.params.id);
        if (!g) return ok({ error: "no such game" }, 404);
        const body = await json(req);
        Object.assign(g.human, body);
        saveGame(g);
        broadcast({ type: "human", gameId: g.id, human: g.human });
        settleWinner(g);
        return ok(g.human);
      },
    },
    // Agent side: the page executes every tool call (that's WebMCP) and reports each one here for the audit trail + scoreboard.
    "/api/games/:id/guest/:guest/call": {
      POST: async (req) => {
        const g = games.get(req.params.id);
        if (!g) return ok({ error: "no such game" }, 404);
        const guest = g.guests[req.params.guest];
        const body = await json(req);
        toolLog(g.id, { kind: "tool_call", guest: req.params.guest, tool: body.tool, input: body.input, result: body.result });
        if (guest) {
          guest.toolCalls++;
          if (body.tool === "edit_tool") guest.toolsEdited++;
          if (body.status) {
            if (guest.status === "arriving" && body.status === "playing") { guest.status = "playing"; guest.startedAt = Date.now(); }
            if (body.status === "won" || body.status === "lost") {
              if (body.status === "lost" && g.allowRetry) { guest.retries++; }
              else { guest.status = body.status; guest.endedAt = Date.now(); }
            }
          }
          if (typeof body.moves === "number") guest.moves = body.moves;
          saveGame(g);
          broadcast({ type: "guest", gameId: g.id, guest, board: body.board });
          settleWinner(g);
        }
        return ok({ ok: true });
      },
    },
    "/api/games/:id/invite": {
      POST: async (req) => {
        const g = games.get(req.params.id);
        if (!g) return ok({ error: "no such game" }, 404);
        const body = await json(req);
        const n = Math.max(1, Math.min(8, Number(body.count ?? 1)));
        const invited: Guest[] = [];
        for (let i = 0; i < n; i++) {
          const k = Object.keys(g.guests).length;
          const name = `${PARTY_NAMES[k % PARTY_NAMES.length]}-${k + 1}`;
          const guest: Guest = { name, hat: HATS[k % HATS.length], status: "arriving", moves: 0, toolCalls: 0, toolsEdited: 0, retries: 0 };
          g.guests[name] = guest;
          invited.push(guest);
          const url = `http://localhost:${PORT}/?game=${g.id}&guest=${encodeURIComponent(name)}`;
          Bun.spawn(["open", "-a", "Google Chrome", url]).exited.catch(() => {});
          waitForGuestTab(g.id, name).then((ready) => {
            if (!ready) appendTranscript(g.id, name, { kind: "error", message: "guest tab never connected" });
          });
          inviteGuest({
            gameId: g.id,
            name, url,
            model: body.model || "gpt-5.6-luna",
            reasoningEffort: body.reasoningEffort || "low",
            onEvent: (ev) => {
              appendTranscript(g.id, name, ev);
              broadcast({ type: "chatter", gameId: g.id, guest: name, ev });
              if (ev.kind === "session") { guest.threadId = ev.threadId; saveGame(g); }
              if (ev.kind === "finish") {
                if (guest.status === "arriving" || guest.status === "playing") guest.status = "left";
                guest.endedAt ??= Date.now();
                saveGame(g);
                broadcast({ type: "guest", gameId: g.id, guest });
                settleWinner(g);
              }
              if (ev.kind === "error") {
                guest.status = "error"; guest.error = ev.message; guest.endedAt = Date.now();
                saveGame(g);
                broadcast({ type: "guest", gameId: g.id, guest });
                settleWinner(g);
              }
            },
          });
        }
        saveGame(g);
        broadcast({ type: "game", game: g });
        return ok(invited, 201);
      },
    },
    "/api/games/:id/guest/:guest/heckle": {
      POST: async (req) => {
        const body = await json(req);
        const sent = await heckleGuest(req.params.guest, String(body.message || "You're losing to a human, you know."));
        if (sent) appendTranscript(req.params.id, req.params.guest, { kind: "heckle", text: body.message });
        return ok({ sent });
      },
    },
    "/api/games/:id/transcript/:guest": {
      GET: (req) => {
        const f = join(gameDir(req.params.id), "guests", `${req.params.guest}.jsonl`);
        if (!existsSync(f)) return ok([]);
        return ok(readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
      },
    },
    "/api/games/:id/tool-calls": {
      GET: (req) => {
        const f = join(gameDir(req.params.id), "tool-calls.jsonl");
        if (!existsSync(f)) return ok([]);
        return ok(readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
      },
    },
  },
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: {} })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) { sockets.add(ws); },
    close(ws) {
      sockets.delete(ws);
      for (const [k, v] of guestTabs) if (v.ws === ws) guestTabs.delete(k);
    },
    message(ws, raw) {
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === "hello" && m.gameId && m.guest) { guestTabs.set(`${m.gameId}/${m.guest}`, { ws, tools: [] }); }
      if (m.type === "webmcp-tools" && m.gameId && m.guest) {
        const k = `${m.gameId}/${m.guest}`;
        guestTabs.set(k, { ws, tools: m.tools ?? [] });
      }
      if (m.type === "webmcp-result" && m.id) {
        const p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); p.resolve(m.result); }
      }
    },
  },
});

console.log(`🎉 Minesweeper Challenge Party at http://localhost:${server.port}`);
