import { useCallback, useEffect, useRef, useState } from "react";
import { Board } from "@/components/Board";
import { Transcript, type Entry } from "@/components/Transcript";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { api, openSocket, post, type Game, type GuestEvent, type ToolDefinition } from "@/lib/api";
import { Minesweeper, type CellView } from "@/lib/minesweeper";
import { createGuestWebMCP } from "@/lib/webmcp";

const params = new URLSearchParams(location.search);
const GUEST_NAME = params.get("guest");
const GAME_ID = params.get("game");

type Settings = {
  rows: number;
  cols: number;
  mines: number;
  model: string;
  effort: "low" | "medium" | "high";
  allowRetry: boolean;
  spectate: boolean;
  sameLayout: boolean;
  toolHead: string;
  seed: string;
};

const defaultSettings: Settings = { rows: 9, cols: 9, mines: 10, model: "gpt-5.6-luna", effort: "low", allowRetry: true, spectate: false, sameLayout: false, toolHead: "", seed: "" };

function modelLabel(model: string) {
  return model
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.toUpperCase() === "GPT" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

let entryCounter = 0;
const nextId = () => `entry-${++entryCounter}`;

function useClock(startedAt: number | null, endedAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt || endedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [startedAt, endedAt]);
  if (!startedAt) return 0;
  return ((endedAt ?? now) - startedAt) / 1000;
}

export default function App() {
  return GUEST_NAME && GAME_ID ? <GuestView gameId={GAME_ID} guestName={GUEST_NAME} /> : <HostView />;
}

function HostView() {
  const [advanced, setAdvanced] = useState(() => localStorage.getItem("advanced") === "1");
  const [settings, setSettings] = useState<Settings>(() => ({ ...defaultSettings, ...JSON.parse(localStorage.getItem("settings") || "{}") }));
  const [connected, setConnected] = useState(false);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [game, setGame] = useState<Game | null>(null);
  const [starting, setStarting] = useState(false);
  const [humanEntries, setHumanEntries] = useState<Entry[]>([]);
  const [agentEntries, setAgentEntries] = useState<Entry[]>([]);
  const [humanView, setHumanView] = useState<CellView[][] | null>(null);
  const [agentView, setAgentView] = useState<CellView[][] | null>(null);
  const [raceStartedAt, setRaceStartedAt] = useState<number | null>(null);
  const [raceEndedAt, setRaceEndedAt] = useState<number | null>(null);
  const engineRef = useRef<Minesweeper | null>(null);
  const gameRef = useRef<Game | null>(null);
  const toolCallNames = useRef(new Map<string, string>());
  gameRef.current = game;

  const clock = useClock(raceStartedAt, raceEndedAt);
  const agentLabel = modelLabel(settings.model);
  const lastRetries = useRef(0);

  useEffect(() => {
    localStorage.setItem("advanced", advanced ? "1" : "");
  }, [advanced]);
  useEffect(() => {
    localStorage.setItem("settings", JSON.stringify(settings));
  }, [settings]);

  const appendAgent = useCallback((entry: Entry) => setAgentEntries((entries) => [...entries, entry]), []);

  const handleGuestEvent = useCallback(
    (event: GuestEvent) => {
      const finalizeStreams = (entries: Entry[]) => entries.map((entry) => (entry.type === "reasoning" || entry.type === "text") && entry.streaming ? { ...entry, streaming: false } : entry);
      if (event.kind === "reasoning" || event.kind === "text") {
        setAgentEntries((entries) => {
          const last = entries[entries.length - 1];
          if (last && last.type === event.kind && last.streaming) return [...entries.slice(0, -1), { ...last, text: last.text + event.text }];
          return [...finalizeStreams(entries), { id: nextId(), type: event.kind, text: event.text, streaming: true }];
        });
        return;
      }
      setAgentEntries(finalizeStreams);
      if (event.kind === "session") appendAgent({ id: nextId(), type: "note", text: `${agentLabel} joined · session ${event.threadId}` });
      if (event.kind === "tool-call") {
        const args = (event.input as { arguments?: { name?: string; input?: unknown } })?.arguments ?? {};
        const isListTools = /webmcp_list_tools/.test(event.toolName);
        const name = isListTools ? "list_tools" : args.name ?? event.toolName.replace(/^mcp__\w+__/, "");
        const input = isListTools ? {} : args.input ?? {};
        toolCallNames.current.set(event.id ?? "", name);
        appendAgent({ id: event.id ?? nextId(), type: "tool", name, input, state: "input-available", title: name === "edit_tool" ? `edit_tool → ${(input as { name?: string }).name ?? ""}` : undefined });
        if (name === "edit_tool") appendAgent({ id: nextId(), type: "note", tone: "big", text: `Built a new tool: ${(input as { name?: string }).name}. Every future agent gets it.` });
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
        if (/"hitMine":true/.test(text)) appendAgent({ id: nextId(), type: "note", tone: "bad", text: gameRef.current?.allowRetry ? "Hit a mine. Trying again on the same board." : "Hit a mine. Out." });
        else if (/"status":"won"/.test(text)) appendAgent({ id: nextId(), type: "note", tone: "good", text: "Cleared the board." });
      }
      if (event.kind === "finish") appendAgent({ id: nextId(), type: "note", text: "Done." });
      if (event.kind === "error") appendAgent({ id: nextId(), type: "note", tone: "bad", text: event.message });
    },
    [agentLabel, appendAgent],
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
        setGame((previous) => (previous ? { ...previous, guests: { ...previous.guests, [message.guest.name]: message.guest } } : previous));
        if (message.board) setAgentView(message.board);
        if (message.guest.retries > lastRetries.current) {
          lastRetries.current = message.guest.retries;
          appendAgent({ id: nextId(), type: "note", text: `Attempt ${message.guest.retries + 1}` });
        }
      }
      if (message.type === "chatter") handleGuestEvent(message.ev);
      if (message.type === "winner") {
        setGame((previous) => (previous ? { ...previous, winner: message.winner } : previous));
        setRaceEndedAt(Date.now());
      }
    };
    api<{ tools: ToolDefinition[] }>("/api/tools").then((config) => setTools(config.tools));
    return () => socket.close();
  }, [handleGuestEvent]);

  async function startRace() {
    setStarting(true);
    const created = await post<Game>("/api/games", {
      rows: settings.rows,
      cols: settings.cols,
      mines: settings.mines,
      seed: settings.seed ? Number(settings.seed) : undefined,
      toolHead: settings.toolHead,
      allowRetry: settings.allowRetry,
      spectate: settings.spectate,
      useLast: settings.sameLayout,
    });
    toolCallNames.current.clear();
    lastRetries.current = 0;
    setHumanEntries([]);
    setAgentEntries([]);
    setAgentView(null);
    setRaceEndedAt(null);
    setRaceStartedAt(Date.now());
    const engine = new Minesweeper({ rows: created.rows, cols: created.cols, mines: created.mines, seed: created.seed });
    engine.onChange = () => setHumanView(engine.view());
    engineRef.current = engine;
    setHumanView(engine.view());
    setGame(created);
    await post(`/api/games/${created.id}/invite`, { count: 1, model: settings.model, reasoningEffort: settings.effort });
    setStarting(false);
  }

  async function humanMove(kind: "dig" | "flag", row: number, col: number) {
    const engine = engineRef.current;
    const current = gameRef.current;
    if (!engine || !current || current.human.status === "won" || current.human.status === "lost") return;
    const wasReady = engine.status === "ready";
    const result = kind === "dig" ? engine.reveal(row, col) : engine.toggleFlag(row, col);
    if (!result.ok) return;
    const patch: Partial<Game["human"]> = { moves: current.human.moves + 1 };
    if (wasReady && !current.human.startedAt) {
      patch.status = "playing";
      patch.startedAt = Date.now();
    }
    setHumanEntries((entries) => [...entries, { id: nextId(), type: "tool", name: kind, input: { row, col }, output: result, state: "output-available" }]);
    if (engine.status === "won") {
      patch.status = "won";
      patch.endedAt = Date.now();
      setHumanEntries((entries) => [...entries, { id: nextId(), type: "note", tone: "good", text: "You cleared the board." }]);
    }
    if (engine.status === "lost") {
      patch.status = "lost";
      patch.endedAt = Date.now();
      setHumanEntries((entries) => [...entries, { id: nextId(), type: "note", tone: "bad", text: "You hit a mine. That was your one life." }]);
    }
    const human = await post<Game["human"]>(`/api/games/${current.id}/human`, patch);
    setGame((previous) => (previous ? { ...previous, human } : previous));
  }

  const guest = game ? Object.values(game.guests)[0] : undefined;
  const engine = engineRef.current;
  const phase = !game ? "idle" : game.winner ? "done" : "running";
  const resultText = game?.winner === "human" ? "You win." : game?.winner === "nobody" ? "Nobody cleared it." : game?.winner ? `${agentLabel} wins.` : "";

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
          <div className="mb-2 text-sm font-medium">You</div>
          <Transcript entries={humanEntries} from="user" emptyTitle={phase === "idle" ? "Your moves will show here." : "Make a move."} />
        </section>

        <section className="pt-7">
          <Board view={humanView} rows={game?.rows ?? settings.rows} cols={game?.cols ?? settings.cols} revealedMines={engine?.status === "lost" ? engine.mine : null} onReveal={phase === "running" && !game?.spectate ? (row, col) => humanMove("dig", row, col) : undefined} onFlag={phase === "running" && !game?.spectate ? (row, col) => humanMove("flag", row, col) : undefined} dimmed={phase !== "running" || game?.spectate} />
        </section>

        <section className="flex flex-col items-center gap-4 pt-7 text-center">
          <div className="font-mono text-4xl tabular-nums">{clock.toFixed(1)}s</div>
          {phase === "idle" && (
            <Button size="lg" className="w-full" disabled={!connected || starting} onClick={startRace}>
              {starting ? "Starting…" : "Start the race"}
            </Button>
          )}
          {phase === "running" && (
            <div className="space-y-1 text-sm text-muted-foreground">
              <div>
                You: <span className="text-foreground">{game?.spectate ? "watching" : game?.human.status}</span>
              </div>
              <div>
                Luna: <span className="text-foreground">{guest?.status ?? "on the way"}</span>
              </div>
            </div>
          )}
          {phase === "done" && (
            <>
              <div className="text-xl font-semibold">{resultText}</div>
              <Button size="lg" className="w-full" onClick={() => { setGame(null); setRaceStartedAt(null); setRaceEndedAt(null); }}>
                Play again
              </Button>
            </>
          )}
        </section>

        <section className="pt-7">
          <Board view={agentView} rows={game?.rows ?? settings.rows} cols={game?.cols ?? settings.cols} dimmed={phase !== "running"} />
        </section>

        <section className="h-[70vh] min-h-0 min-w-0">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            {agentLabel}
            <Badge variant="outline" className="text-[10px]">{settings.effort} effort</Badge>
            {guest && guest.retries > 0 && <Badge variant="secondary" className="text-[10px]">attempt {guest.retries + 1}</Badge>}
          </div>
          <Transcript entries={agentEntries} from="assistant" emptyTitle={phase === "idle" ? "Luna's moves will show here." : "Waiting for Luna…"} waiting={phase === "running" && agentEntries.length === 0} />
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
              <Field label="Model">
                <select className={inputClass} value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })}>
                  {["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"].map((model) => <option key={model}>{model}</option>)}
                </select>
              </Field>
              <Field label="Effort">
                <select className={inputClass} value={settings.effort} onChange={(event) => setSettings({ ...settings, effort: event.target.value as Settings["effort"] })}>
                  {["low", "medium", "high"].map((effort) => <option key={effort}>{effort}</option>)}
                </select>
              </Field>
              <Field label="Board seed"><input className={inputClass} placeholder="random" value={settings.seed} onChange={(event) => setSettings({ ...settings, seed: event.target.value })} /></Field>
            </div>
            <Field label="Which tools Luna starts with">
              <select className={inputClass} value={settings.toolHead} onChange={(event) => setSettings({ ...settings, toolHead: event.target.value })}>
                <option value="">Everything Luna has ever built</option>
                <option value="0">Just the basics</option>
              </select>
            </Field>
            <div className="mt-3 space-y-2">
              <Toggle label="Luna can retry after a mine" checked={settings.allowRetry} onChange={(allowRetry) => setSettings({ ...settings, allowRetry })} />
              <Toggle label="I just want to watch" checked={settings.spectate} onChange={(spectate) => setSettings({ ...settings, spectate })} />
              <Toggle label="Same board as last time" checked={settings.sameLayout} onChange={(sameLayout) => setSettings({ ...settings, sameLayout })} />
            </div>
          </div>
          <div className="rounded-lg border border-border p-4 text-sm">
            <h2 className="mb-3 font-medium">Luna's tools</h2>
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
  const [attempt, setAttempt] = useState(1);
  const gameRef = useRef<Game | null>(null);
  const engineRef = useRef<Minesweeper | null>(null);
  const [elapsed, setElapsed] = useState(0);
  gameRef.current = game;

  useEffect(() => {
    let disposed = false;
    const socket = openSocket();
    (async () => {
      const loaded = await api<Game & { error?: string }>(`/api/games/${gameId}`);
      if (disposed || loaded.error) return;
      setGame(loaded);
      const engine = new Minesweeper({ rows: loaded.rows, cols: loaded.cols, mines: loaded.mines, seed: loaded.seed });
      engine.onChange = () => setView(engine.view());
      engineRef.current = engine;
      setView(engine.view());
      const webmcp = createGuestWebMCP({ gameId, guestName, socket, engine, getGame: () => gameRef.current });
      const load = async () => {
        const config = await api<{ tools: ToolDefinition[] }>(`/api/tools?game=${gameId}`);
        await webmcp.registerAll(config.tools);
      };
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "tools") load();
        if (message.type === "guest" && message.gameId === gameId && message.guest.name === guestName) setAttempt(message.guest.retries + 1);
      });
      await load();
    })();
    const timer = setInterval(() => setElapsed(engineRef.current?.elapsed() ?? 0), 100);
    return () => {
      disposed = true;
      clearInterval(timer);
      socket.close();
    };
  }, [gameId, guestName]);

  const engine = engineRef.current;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
      <div className="text-sm text-muted-foreground">GPT 5.6 Luna{attempt > 1 ? ` · attempt ${attempt}` : ""}</div>
      <div className="font-mono text-3xl tabular-nums">{elapsed.toFixed(1)}s</div>
      {game && <Board view={view} rows={game.rows} cols={game.cols} revealedMines={engine?.status === "lost" ? engine.mine : null} />}
    </div>
  );
}
