# usertrust-ui

Local web UI for a [`usertrust`](https://usertrust.ai) audit vault: a filterable, live-tailing ledger of every governed agent action, with built-in per-transaction verification and a spend trends dashboard.

```bash
npx usertrust-ui            # serve the vault in the current directory
```

Then open `http://127.0.0.1:4180` (opens automatically unless `--no-open`).

## What you get

- **Audit table** — every ledger event as a row: timestamp, kind, task type, transaction id, cost in UT, and chain integrity. Full-text search, faceted filters, column sorting, virtualized for large vaults.
- **Live tail** — new events stream in over SSE as they are written; each appended event is re-verified (hash + linkage) before it renders. Tampering mid-session raises a red integrity banner.
- **Row drill-in** — click a row for the full event payload and a one-click **Verify** that replays the independent `usertrust-verify` check and renders a thermal-receipt style result.
- **Trends** — spend over time and cost by task type.
- **Summary strip** — budget, spent/remaining UT, chain status, and anchor state, always visible.

## Usage

```bash
npx usertrust-ui [rootDir] [--port N] [--no-open]
```

| Flag | Meaning |
|------|---------|
| `rootDir` | Project root containing `.usertrust/` (default: cwd) |
| `--port N` | Bind exactly this port (default: probe 4180-4199) |
| `--no-open` | Don't open the browser |

If `usertrust` (the core CLI) is installed alongside, `usertrust ui` launches the same server.

## Security model

- **Loopback only.** The server binds `127.0.0.1` and rejects requests whose `Host` header is not loopback (DNS-rebinding guard) and cross-origin POSTs (CSRF guard).
- **Read-only**, with one exception: `POST /api/export` writes a markdown export, and only to a directory inside the project root (never inside the vault).
- **No secrets on the wire.** The audit chain stores metadata (hashes, costs, task types) — never raw prompts or completions — so the UI cannot leak them.

## Markdown export

Prefer files over a web UI? The same receipts export to an Obsidian-ready markdown vault:

```bash
usertrust export --markdown <dir>
```

Each receipt becomes a note wikilinked to its predecessor, so the hash chain renders as a chain in graph view.
