import { useCallback, useEffect, useRef, useState } from "react";
import { Board } from "@/components/Board";
import { Transcript, type Entry } from "@/components/Transcript";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { api, openSocket, post, type Game, type Guest, type GuestEvent, type ToolDefinition } from "@/lib/api";
import { boardSeed, Minesweeper, type CellView } from "@/lib/minesweeper";
import { createGuestWebMCP } from "@/lib/webmcp";

const params = new URLSearchParams(location.search);
const GUEST_NAME = params.get("guest");
const GAME_ID = params.get("game");

type Settings = {
  rows: number;
  cols: number;
  mines: number;
  minutes: number;
  model: string;
  effort: "low" | "medium" | "high";
  spectate: boolean;
  sameLayout: boolean;
  toolHead: string;
  seed: string;
};

const defaultSettings: Settings = { rows: 9, cols: 9, mines: 10, minutes: 2, model: "gpt-5.6-terra", effort: "low", spectate: false, sameLayout: false, toolHead: "", seed: "" };

function modelLabel(model: string) {
  return model
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.toUpperCase() === "GPT" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

let entryCounter = 0;
const nextId = () => `entry-${++entryCounter}`;

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function formatClock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function describeTool(name: string, input: unknown): string {
  const coords = input as { row?: number; col?: number } | undefined;
  const at = coords && coords.row !== undefined ? ` ${coords.row},${coords.col}` : "";
  if (name === "reveal_cell" || name === "dig") return `Dig${at}`;
  if (name === "flag_cell" || name === "flag") return `Flag${at}`;
  if (name === "look_at_board") return "Look";
  if (name === "list_tools") return "Check tools";
  if (name === "ready_up") return "Ready";
  if (name === "edit_tool") return `Build tool ${(input as { name?: string })?.name ?? ""}`;
  return name;
}

export default function App() {
  return GUEST_NAME && GAME_ID ? <GuestView gameId={GAME_ID} guestName={GUEST_NAME} /> : <HostView />;
}

function HostView() {
  const [advanced, setAdvanced] = useState(() => localStorage.getItem("advanced") === "1");
  const [settings, setSettings] = useState<Settings>(() => {
    const saved = JSON.parse(localStorage.getItem("settings-v2") || "{}") as Partial<Settings>;
    const model = ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5"].includes(saved.model ?? "") ? saved.model! : defaultSettings.model;
    return { ...defaultSettings, ...saved, model };
  });
  const [connected, setConnected] = useState(false);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [game, setGame] = useState<Game | null>(null);
  const [starting, setStarting] = useState(false);
  const [humanEntries, setHumanEntries] = useState<Entry[]>([]);
  const [agentEntries, setAgentEntries] = useState<Entry[]>([]);
  const [humanView, setHumanView] = useState<CellView[][] | null>(null);
  const [agentView, setAgentView] = useState<CellView[][] | null>(null);
  const [raceLog, setRaceLog] = useState<string[]>([]);
  const engineRef = useRef<Minesweeper | null>(null);
  const gameRef = useRef<Game | null>(null);
  const lastBoardIndex = useRef(0);
  gameRef.current = game;

  const agentLabel = modelLabel(settings.model);
  const phase = !game ? "idle" : game.winner ? "done" : game.startedAt ? "running" : "invited";
  const now = useNow(phase === "running");
  const timeLeft = game?.startedAt ? game.startedAt + game.durationMs - now : (game?.durationMs ?? settings.minutes * 60_000);
  const timeUp = phase === "running" && timeLeft <= 0;

  useEffect(() => localStorage.setItem("advanced", advanced ? "1" : ""), [advanced]);
  useEffect(() => localStorage.setItem("settings-v2", JSON.stringify(settings)), [settings]);

  const appendAgent = useCallback((entry: Entry) => setAgentEntries((entries) => [...entries, entry]), []);
  const appendHuman = useCallback((entry: Entry) => setHumanEntries((entries) => [...entries, entry]), []);
  const appendRace = useCallback((line: string) => setRaceLog((lines) => [...lines, line]), []);

  const handleGuestEvent = useCallback(
    (event: GuestEvent) => {
      const finalizeStreams = (entries: Entry[]) => entries.map((entry) => ((entry.type === "reasoning" || entry.type === "text") && entry.streaming ? { ...entry, streaming: false } : entry));
      if (event.kind === "reasoning" || event.kind === "text") {
        setAgentEntries((entries) => {
          const last = entries[entries.length - 1];
          if (last && last.type === event.kind && last.streaming) return [...entries.slice(0, -1), { ...last, text: last.text + event.text }];
          return [...finalizeStreams(entries), { id: nextId(), type: event.kind, text: event.text, streaming: true }];
        });
        return;
      }
      setAgentEntries(finalizeStreams);
      if (event.kind === "session") appendAgent({ id: nextId(), type: "note", text: `session ${event.threadId}` });
      if (event.kind === "tool-call") {
        const args = (event.input as { arguments?: { code?: string; title?: string } })?.arguments ?? {};
        const code = args.code ?? "";
        const called = [...code.matchAll(/(?:tools\.call|webmcp\.call)\(\s*["'`]([a-z_]+)["'`]\s*(?:,\s*(\{[^)]*\}))?/g)];
        if (called.length) {
          for (const match of called) {
            let input: unknown = {};
            try {
              input = match[2] ? JSON.parse(match[2].replace(/(\w+)\s*:/g, '"$1":').replace(/'/g, '"')) : {};
            } catch {}
            appendAgent({ id: nextId(), type: "tool", name: match[1], title: describeTool(match[1], input), input: { code }, state: "output-available" });
            if (match[1] === "edit_tool") appendAgent({ id: nextId(), type: "note", tone: "big", text: "Built a new tool. Every future agent gets it." });
          }
        } else {
          appendAgent({ id: event.id ?? nextId(), type: "tool", name: "browser", title: args.title || "Browser", input: { code }, state: "input-available" });
        }
      }
      if (event.kind === "tool-result") {
        const raw = event.output as { result?: unknown; error?: unknown } | undefined;
        let output: unknown = raw?.result ?? raw;
        const content = (output as { content?: { text?: string }[] })?.content;
        if (Array.isArray(content) && content[0]?.text) {
          try {
            output = JSON.parse(content[0].text);
          } catch {
            output = content[0].text;
          }
        }
        setAgentEntries((entries) => entries.map((entry) => (entry.type === "tool" && entry.id === event.id ? { ...entry, output, state: raw?.error ? "output-error" : "output-available", errorText: raw?.error ? String(raw.error) : undefined } : entry)));
        const text = JSON.stringify(output ?? "");
        if (/"hitMine":true/.test(text)) appendAgent({ id: nextId(), type: "note", tone: "bad", text: "Boom. Next board." });
        else if (/"status":"won"/.test(text)) appendAgent({ id: nextId(), type: "note", tone: "good", text: "Solved. Next board." });
      }
      if (event.kind === "finish") appendAgent({ id: nextId(), type: "note", text: "Done." });
      if (event.kind === "error") appendAgent({ id: nextId(), type: "note", tone: "bad", text: event.message });
    },
    [agentLabel, appendAgent, appendRace],
  );

  useEffect(() => {
    const socket = openSocket();
    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onmessage = (raw) => {
      const message = JSON.parse(raw.data);
      if (message.type === "tools") setTools(message.tools);
      const current = gameRef.current;
      if (!current || (message.gameId && message.gameId !== current.id)) return;
      if (message.type === "guest") {
        const guest = message.guest as Guest;
        const before = current.guests[guest.name];
        if (before?.status === "arriving" && guest.status === "ready") appendRace(`${agentLabel} joined`);
        setGame((previous) => (previous ? { ...previous, guests: { ...previous.guests, [guest.name]: guest } } : previous));
        if (message.board) setAgentView(message.board);
        if (guest.boardIndex > lastBoardIndex.current) {
          lastBoardIndex.current = guest.boardIndex;
          appendAgent({ id: nextId(), type: "note", text: `Board ${guest.boardIndex + 1}` });
        }
      }
      if (message.type === "chatter") handleGuestEvent(message.ev);
      if (message.type === "started") {
        setGame((previous) => (previous ? { ...previous, startedAt: message.startedAt, durationMs: message.durationMs } : previous));
        appendRace("Race started");
      }
      if (message.type === "winner") {
        setGame((previous) => (previous ? { ...previous, winner: message.winner, human: message.human ?? previous.human, guests: message.guests ?? previous.guests } : previous));
        appendRace("Time's up");
      }
    };
    api<{ tools: ToolDefinition[] }>("/api/tools").then((config) => setTools(config.tools));
    return () => socket.close();
  }, [handleGuestEvent, appendAgent, appendRace]);

  function loadHumanBoard(created: Game, boardIndex: number) {
    const engine = new Minesweeper({ rows: created.rows, cols: created.cols, mines: created.mines, seed: boardSeed(created.seed, boardIndex) });
    engine.onChange = () => setHumanView(engine.view());
    engineRef.current = engine;
    setHumanView(engine.view());
  }

  async function inviteTerra() {
    setStarting(true);
    const created = await post<Game>("/api/games", {
      rows: settings.rows,
      cols: settings.cols,
      mines: settings.mines,
      durationMs: settings.minutes * 60_000,
      seed: settings.seed ? Number(settings.seed) : undefined,
      toolHead: settings.toolHead,
      spectate: settings.spectate,
      useLast: settings.sameLayout,
    });
    lastBoardIndex.current = 0;
    setHumanEntries([]);
    setAgentEntries([]);
    setAgentView(null);
    setRaceLog([`${agentLabel} invited`]);
    loadHumanBoard(created, 0);
    setGame(created);
    const invited = await post<Guest[]>(`/api/games/${created.id}/invite`, { count: 1, model: settings.model, reasoningEffort: settings.effort });
    setGame((previous) => (previous && previous.id === created.id ? { ...previous, guests: Object.fromEntries(invited.map((guest) => [guest.name, guest])) } : previous));
    setStarting(false);
  }

  async function startRace() {
    if (!game) return;
    await post(`/api/games/${game.id}/start`, {});
  }

  async function humanMove(kind: "dig" | "flag", row: number, col: number) {
    const engine = engineRef.current;
    const current = gameRef.current;
    if (!engine || !current || !current.startedAt || current.winner || Date.now() > current.startedAt + current.durationMs) return;
    const result = kind === "dig" ? engine.reveal(row, col) : engine.toggleFlag(row, col);
    if (!result.ok) return;
    const patch: Partial<Game["human"]> = { moves: current.human.moves + 1, status: "playing" };
    if (!current.human.startedAt) patch.startedAt = Date.now();
    appendHuman({ id: nextId(), type: "tool", name: kind, title: describeTool(kind, { row, col }), input: {}, state: "output-available" });
    if (engine.status === "won") {
      patch.solved = current.human.solved + 1;
      patch.boardIndex = current.human.boardIndex + 1;
      appendHuman({ id: nextId(), type: "note", tone: "good", text: "Solved. Next board." });
      appendRace(`You solved board ${current.human.boardIndex + 1}`);
      loadHumanBoard(current, patch.boardIndex);
    } else if (engine.status === "lost") {
      patch.boardIndex = current.human.boardIndex + 1;
      appendHuman({ id: nextId(), type: "note", tone: "bad", text: "Boom. Next board." });
      appendRace(`You hit a mine on board ${current.human.boardIndex + 1}`);
      setHumanView(engine.view());
      setTimeout(() => loadHumanBoard(current, patch.boardIndex!), 700);
    }
    const human = await post<Game["human"]>(`/api/games/${current.id}/human`, patch);
    setGame((previous) => (previous ? { ...previous, human } : previous));
  }

  const guest = game ? Object.values(game.guests)[0] : undefined;
  const engine = engineRef.current;
  const terraReady = guest?.status === "ready";
  const resultText = game?.winner === "human" ? "You win." : game?.winner === "tie" ? "Tie." : game?.winner === "nobody" ? "Nobody solved a board." : game?.winner ? `${agentLabel} wins.` : "";
  const canPlay = phase === "running" && !timeUp && !game?.spectate;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">Minesweeper Challenge Party</h1>
        <label className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground">
          Advanced mode
          <Switch checked={advanced} onCheckedChange={setAdvanced} />
        </label>
      </header>

      <main className="grid grid-cols-[minmax(0,1fr)_auto_200px_auto_minmax(0,1fr)] items-start gap-5 px-6 pb-10">
        <section className="h-[70vh] min-h-0 min-w-0">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            You
            {game && <Badge variant="secondary" className="text-[10px]">{game.human.solved} solved</Badge>}
          </div>
          <Transcript entries={humanEntries} from="user" emptyTitle={canPlay ? "Make a move." : "Your moves will show here."} />
        </section>

        <section className="pt-7">
          <Board view={humanView} rows={game?.rows ?? settings.rows} cols={game?.cols ?? settings.cols} revealedMines={engine?.status === "lost" ? engine.mine : null} onReveal={canPlay ? (row, col) => humanMove("dig", row, col) : undefined} onFlag={canPlay ? (row, col) => humanMove("flag", row, col) : undefined} dimmed={!canPlay} />
        </section>

        <section className="flex h-[70vh] flex-col items-center gap-4 pt-7 text-center">
          <div className="font-mono text-4xl tabular-nums">{formatClock(timeLeft)}</div>
          {game && (
            <div className="text-sm text-muted-foreground">
              <span className="text-foreground">{game.spectate ? "–" : game.human.solved}</span> · <span className="text-foreground">{guest?.solved ?? 0}</span>
            </div>
          )}
          {phase === "idle" && (
            <Button size="lg" className="w-full" disabled={!connected || starting} onClick={inviteTerra}>
              {starting ? "Inviting…" : "Invite Terra"}
            </Button>
          )}
          {phase === "invited" && (
            <Button size="lg" className="w-full" disabled={!terraReady} onClick={startRace}>
              {terraReady ? "Start the race" : "Waiting for Terra…"}
            </Button>
          )}
          {phase === "done" && (
            <>
              <div className="text-xl font-semibold">{resultText}</div>
              <Button size="lg" className="w-full" onClick={() => { setGame(null); setRaceLog([]); }}>
                Play again
              </Button>
            </>
          )}
          <div className="mt-2 w-full flex-1 space-y-1 overflow-auto rounded-lg border border-border bg-card/40 p-3 text-left text-xs text-muted-foreground">
            {raceLog.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
          </div>
        </section>

        <section className="pt-7">
          <Board view={agentView} rows={game?.rows ?? settings.rows} cols={game?.cols ?? settings.cols} dimmed={phase !== "running"} />
        </section>

        <section className="h-[70vh] min-h-0 min-w-0">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            {agentLabel}
            <Badge variant="outline" className="text-[10px]">{settings.effort} effort</Badge>
            {guest && <Badge variant="secondary" className="text-[10px]">{guest.solved} solved</Badge>}
          </div>
          <Transcript entries={agentEntries} from="assistant" emptyTitle="Terra's moves will show here." waiting={phase !== "idle" && phase !== "done" && agentEntries.length === 0} />
        </section>
      </main>

      {advanced && (
        <section className="grid grid-cols-2 gap-5 px-6 pb-12">
          <div className="rounded-lg border border-border p-4 text-sm">
            <h2 className="mb-3 font-medium">Settings</h2>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Rows"><input type="number" className={inputClass} value={settings.rows} onChange={(event) => setSettings({ ...settings, rows: +event.target.value })} /></Field>
              <Field label="Cols"><input type="number" className={inputClass} value={settings.cols} onChange={(event) => setSettings({ ...settings, cols: +event.target.value })} /></Field>
              <Field label="Mines"><input type="number" className={inputClass} value={settings.mines} onChange={(event) => setSettings({ ...settings, mines: +event.target.value })} /></Field>
              <Field label="Minutes"><input type="number" className={inputClass} value={settings.minutes} min={1} max={30} onChange={(event) => setSettings({ ...settings, minutes: +event.target.value })} /></Field>
              <Field label="Model">
                <select className={inputClass} value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })}>
                  {["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5"].map((model) => <option key={model}>{model}</option>)}
                </select>
              </Field>
              <Field label="Effort">
                <select className={inputClass} value={settings.effort} onChange={(event) => setSettings({ ...settings, effort: event.target.value as Settings["effort"] })}>
                  {["low", "medium", "high"].map((effort) => <option key={effort}>{effort}</option>)}
                </select>
              </Field>
              <Field label="Board seed"><input className={inputClass} placeholder="random" value={settings.seed} onChange={(event) => setSettings({ ...settings, seed: event.target.value })} /></Field>
            </div>
            <Field label="Which tools Terra starts with">
              <select className={inputClass} value={settings.toolHead} onChange={(event) => setSettings({ ...settings, toolHead: event.target.value })}>
                <option value="">Everything Terra has ever built</option>
                <option value="0">Just the basics</option>
              </select>
            </Field>
            <div className="mt-3 space-y-2">
              <Toggle label="I just want to watch" checked={settings.spectate} onChange={(spectate) => setSettings({ ...settings, spectate })} />
              <Toggle label="Same boards as last time" checked={settings.sameLayout} onChange={(sameLayout) => setSettings({ ...settings, sameLayout })} />
            </div>
          </div>
          <div className="rounded-lg border border-border p-4 text-sm">
            <h2 className="mb-3 font-medium">Terra's tools</h2>
            <div className="space-y-2">
              {tools.map((tool) => (
                <details key={tool.name} className="rounded-md border border-border p-2">
                  <summary className="flex cursor-pointer justify-between font-mono text-xs">
                    <span>{tool.name}</span>
                    <span className="text-muted-foreground">{tool.by}{tool.memoId ? ` · #${tool.memoId}` : ""}</span>
                  </summary>
                  <p className="mt-2 text-xs text-muted-foreground">{tool.description}</p>
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-black/40 p-2 font-mono text-[11px]">{tool.code}</pre>
                </details>
              ))}
              <div className="rounded-md border border-dashed border-border p-2 font-mono text-xs text-muted-foreground">edit_tool · read-only</div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

const inputClass = "mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function GuestView({ gameId, guestName }: { gameId: string; guestName: string }) {
  const [game, setGame] = useState<Game | null>(null);
  const [view, setView] = useState<CellView[][] | null>(null);
  const gameRef = useRef<Game | null>(null);
  const engineRef = useRef<Minesweeper | null>(null);
  gameRef.current = game;

  useEffect(() => {
    let disposed = false;
    const socket = openSocket();
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", gameId, guest: guestName })));
    (async () => {
      const loaded = await api<Game & { error?: string }>(`/api/games/${gameId}`);
      if (disposed || loaded.error) return;
      setGame(loaded);
      const engine = new Minesweeper({ rows: loaded.rows, cols: loaded.cols, mines: loaded.mines, seed: boardSeed(loaded.seed, 0) });
      engine.onChange = () => setView(engine.view());
      engineRef.current = engine;
      setView(engine.view());
      const webmcp = createGuestWebMCP({ gameId, guestName, engine, getGame: () => gameRef.current });
      const load = async () => {
        const config = await api<{ tools: ToolDefinition[] }>(`/api/tools?game=${gameId}`);
        await webmcp.registerAll(config.tools);
      };
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "tools") load();
        if (message.type === "started" && message.gameId === gameId) setGame((previous) => (previous ? { ...previous, startedAt: message.startedAt, durationMs: message.durationMs } : previous));
      });
      await load();
    })();
    return () => {
      disposed = true;
      socket.close();
    };
  }, [gameId, guestName]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
      {game && <Board view={view} rows={game.rows} cols={game.cols} />}
      <p className="max-w-md text-center text-xs text-muted-foreground">
        This page exposes WebMCP tools via document.modelContext. Without a WebMCP client, use the cdp capability: Runtime.evaluate with JSON.stringify(window.webmcp.listTools()) and window.webmcp.call(name, input).then(JSON.stringify), with awaitPromise and returnByValue.
      </p>
    </div>
  );
}
