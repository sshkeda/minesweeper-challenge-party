# Minesweeper Challenge Party

Race AI agents at Minesweeper while they improve the page's tools for every agent that follows.

The page registers game tools with `document.modelContext.registerTool`. Agents use `edit_tool` to create or rewrite tools, and those changes persist in an append-only `memo` log.

## Run

Requires Bun, Codex CLI, Chrome, and [`memo`](https://github.com/sshkeda/memorylog).

```sh
bun install
cd web && bun install && cd ..
bun --hot server.ts
cd web && bun run dev
```

Open `http://localhost:5173`.

This local prototype executes agent-authored JavaScript against a constrained game API. MIT licensed.
