# 🎉 Minesweeper Challenge Party

**Race AI agents at Minesweeper. They play only through the page's WebMCP tools. Every tool they write stays on the page for the next agent.**

You host. Luna agents (OpenAI `gpt-5.6-luna`, driven through your local Codex) are the guests. Each guest gets one sentence, *"Beat me at Minesweeper,"* and a page whose only interface is a set of WebMCP tools. One of those tools is `edit_tool`, which lets a guest rewrite any other tool on the page, or write a new one. Guests do not get a mouse.

What happens in practice: the first guest looks at the board, reveals one cell, realises one-cell-per-call is slow, and writes itself a `solve_board` constraint solver. The next guest arrives and the solver is already on the table. You stop winning.

This is the answer to "agents can just use the human UI now": they can, but given a way to write tools, they write tools, and leave them behind for whoever comes next. The web paves itself.

## How WebMCP is used

Every tool on the page is registered with `document.modelContext.registerTool({ name, description, inputSchema, execute })`, per the WebMCP imperative API. The defaults are `look_at_board`, `reveal_cell`, `flag_cell`, plus the read-only `edit_tool`. Tool code lives in `memo` (a local append-only log); the current tool set is derived by replaying the log, and edits hot-reload into every open tab, which re-registers everything via `AbortController`.

If the browser has native WebMCP, that is used directly. If not (as of this writing the ChatGPT Chrome extension's WebMCP surface is feature-gated), the page installs a shim with the identical `registerTool` contract and bridges the registrations to the agent over MCP: `webmcp_list_tools` returns exactly what the page registered, `webmcp_call_tool` runs the page's `execute` in the tab. Same tools, same code path, same audit.

## Audit

Every guest is fully auditable:

- `games/<id>/guests/<guest>.jsonl`: every stream part from the agent (text, reasoning, tool-call, tool-result, finish) plus the Codex thread id.
- `games/<id>/tool-calls.jsonl`: every WebMCP execution the page performed, with input and result.
- Transcript viewer in the UI, with a "tool calls only" filter that shows the agent side and the page side next to each other.

## Run it

Requirements: [Bun](https://bun.sh) 1.4+, [Codex CLI](https://github.com/openai/codex) logged in, Google Chrome, and [`memo`](https://github.com/sshkeda/memorylog) on your PATH.

```sh
bun install
cd web && bun install && cd ..
bun --hot server.ts          # API + WebSocket + agent runner on :4321
cd web && bun run dev        # UI on :5173 (proxies /api and /ws)
# open http://localhost:5173
```

1. **Start game**: board size, mine count, retry rule, and which tool config to seed from (default only, latest, or any point in the memo log). "Replay last board" reuses the previous seed so guests face the same layout.
2. **Invite guests**: one or many. Each opens its own tab and plays the same seeded board against you.
3. **Play.** Left click reveals, right click flags. Heckle a guest mid-race with 📣; it lands in its Codex thread via `session.injectMessage`.
4. **Watch the table.** Tools appear as guests write them. Kick one over and the next guest has to rebuild it.

## Files

- `server.ts`: Bun server, WebSocket fan-out, games as JSON, tools via `memo`, WebMCP bridge.
- `web/`: Vite + React + Tailwind + shadcn + AI Elements. Host view, guest view, WebMCP registration (`web/src/lib/webmcp.ts`).
- `agent.ts`: invites guests through the Vercel AI SDK (`ai` 7) and `ai-sdk-provider-codex-app-server`, running your local Codex.

Built in one night for the [WebMCP Challenge](https://webmcp.devpost.com/). MIT.
