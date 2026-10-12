# usertrust-ui

Local web UI for a [`usertrust`](https://usertrust.ai) audit vault: a filterable, live-tailing ledger of every governed agent action, with built-in per-transaction verification and a spend trends dashboard.

```bash
npx usertrust-ui            # serve the vault in the current directory
```

Then open `http://127.0.0.1:4180` (opens automatically unless `--no-open`).

## What you get

- **Audit ledger** — every ledger event as a row: its transfer's outcome, the model, the time in UTC, the actor, the kind, the transfer id, the cost in UT (an estimated cost is marked) and chain integrity. Full-text search, faceted filters with counts, sorting, virtualized for large vaults.
- **Live tail** — new events stream in over SSE as they are written; each appended event is re-verified (hash + linkage) before it renders. Tampering mid-session raises a red integrity banner. A project with no vault yet shows "No governed calls yet", and its first calls appear as they are written.
- **Inspector** — select a row to see its call, cost and chain fields, docked beside the list on a wide screen, and a one-click **Verify** that replays the independent `usertrust-verify` check and renders a thermal-receipt style result: verified, failed, or not found in the live log.
- **Trends** — cost over time (UTC), by kind and by model, for the records in view.
- **Summary** — spend, the budget and where it came from, chain status, and whether an anchor file is present (file presence, not a verification verdict), always visible.

Dark only. No font is shipped or fetched: the page names its font families, and the browser uses one only where it is already installed.

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
- **Nothing leaves the machine by default.** The one remote load, the usertrust mark, is off unless you turn it on (below).

## The usertrust mark (opt-in)

Off by default. When it is on, the header shows the usertrust mark beside the name, loaded from the usertrust brand kit. The mark is not part of this package.

- **What is fetched:** one SVG, `https://usertrust.ai/kit/images/favicon.svg`. Nothing else.
- **When, and by what:** your browser fetches it each time the page loads, and only while the setting is on. The usertrust-ui server makes no request.
- **What is sent:** a plain `GET` with no query string, no cookies (`crossorigin="anonymous"`) and no `Referer` (`referrerpolicy="no-referrer"`). Because it is a CORS request, the browser adds an `Origin` header naming this page's local address, for example `http://127.0.0.1:4180`. Like any web request, it also shows usertrust.ai your IP address, your browser's user agent and the time.
- **If it fails:** the page shows no mark and no error. A load still unfinished after 5 seconds is abandoned. The header keeps its layout either way.

Turn it on in the vault config, `.usertrust/usertrust.config.json`:

```json
{
  "remote": { "kit": true }
}
```

To turn it off, set `"kit": false` or remove the `remote` section. Only the JSON boolean `true` turns it on. The page applies a change within a few seconds, without a restart. The `usertrust` SDK ignores this section.

## Markdown export

Prefer files over a web UI? The same receipts export to an Obsidian-ready markdown vault:

```bash
usertrust export --markdown <dir>
```

Each receipt becomes a note wikilinked to its predecessor, so the hash chain renders as a chain in graph view.
