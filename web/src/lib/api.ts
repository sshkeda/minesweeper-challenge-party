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
  human: { status: "ready" | "playing" | "won" | "lost" | "spectating"; startedAt?: number; endedAt?: number; moves: number; retries: number };
  winner?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  code: string;
  by: string;
  memoId?: number;
};

export type GuestEvent =
  | { kind: "session"; threadId: string }
  | { kind: "joined" }
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool-call"; toolName: string; input: unknown; id?: string }
  | { kind: "tool-result"; toolName: string; output: unknown; id?: string }
  | { kind: "heckle"; text: string }
  | { kind: "raw"; data: unknown }
  | { kind: "finish"; reason: string }
  | { kind: "error"; message: string };

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  return response.json() as Promise<T>;
}

export const post = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

export function openSocket() {
  return new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
}
