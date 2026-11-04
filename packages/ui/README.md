# usertrust-ui

Local web UI for a [`usertrust`](https://usertrust.ai) audit vault: a filterable, live-tailing ledger of every governed agent action, with built-in per-transaction verification and a spend trends dashboard.

```bash
npx usertrust-ui            # serve the vault in the current directory
```

Then open `http://127.0.0.1:4180` (opens automatically unless `--no-open`).

## What you get

- **Audit ledger** — every ledger event as a row: its transfer's outcome, the model, the time in UTC, the actor, the kind, the transfer id, the cost in dollars, then in UT, the ledger's unit (1 UT = $0.0001, one hundredth of a cent; an estimated cost is marked) and chain integrity. Full-text search, faceted filters with counts, sorting, virtualized for large vaults.
- **Live tail** — new events stream in over SSE as they are written; each appended event is re-verified (hash + linkage) before it renders. Tampering mid-session raises a red integrity banner. A project with no vault yet shows "No governed calls yet", and its first calls appear as they are written.
- **Inspector** — select a row to see its call, cost and chain fields, docked beside the list on a wide screen, and a one-click **Verify** that runs the `usertrust-verify` check and renders a thermal-receipt style result under its verdict: verified (only when the receipt proves inclusion against an anchor), consistent, unanchored (the chain agrees with itself, with no anchor to check it against), failed, or not found in any of the vault's audit segments.
- **Trends** — cost over time (UTC), by kind, by model and by job type, for the records in view. The job type is what the caller declared when it authorized the job; the server does not check it: it is a label, it prices nothing, and a record with no type counts as `untyped`, so the job-type totals add up to the total in view. The same type is a filter (with who declared it), a column in the CSV export and a field in the inspector.
- **Summary** — spend, the budget and where it came from, chain status, and whether an anchor file is present (file presence, not a verification verdict), always visible.

The header shows the usertrust logo, bundled into the page (it works offline and costs no request). The logo and the name are trademarks of Usertools, Inc. and are not licensed under Apache-2.0: see `brand/LICENSE` and the repository's `TRADEMARKS.md`. A fork or modified version must remove the mark and rename.

Dark only: there is no light theme. No font is shipped or fetched: the page names its font families, and the browser uses one only where it is already installed.

## Usage

```bash
npx usertrust-ui [rootDir] [--port N] [--no-open]
```

| Flag | Meaning |
|------|---------|
| `rootDir` | Project root containing `.usertrust/` (default: cwd) |
| `--port N` | Bind exactly this port (default: probe 4180-4199) |
| `--no-open` | Don't open the browser |
| `--allow-host NAME` | Also answer requests whose `Host` is `NAME` (repeatable; see [Reaching it from another device](#reaching-it-from-another-device-opt-in)) |

If `usertrust` (the core CLI) is installed alongside, `usertrust ui` launches the same server.

## Security model

- **Loopback only.** The server binds `127.0.0.1` and rejects requests whose `Host` header is not loopback (DNS-rebinding guard) and cross-origin POSTs (CSRF guard). `--allow-host` adds host names to that list and leaves the bind address alone.
- **Read-only**, with one exception: `POST /api/export` writes a markdown export, and only to a directory inside the project root (never inside the vault).
- **No secrets on the wire.** The audit chain stores metadata (hashes, costs, task types) — never raw prompts or completions — so the UI cannot leak them.
- **Nothing leaves the machine by default.** The one remote load, the usertrust mark, is off unless you turn it on (below).

## Reaching it from another device (opt-in)

By default the dashboard answers only `127.0.0.1:<port>` and `localhost:<port>`. To open it from your phone through a private network proxy such as `tailscale serve`, which forwards to the loopback address, name the host the proxy presents:

```sh
usertrust-ui --allow-host my-mac.example-tailnet.ts.net
tailscale serve --bg http://127.0.0.1:4180
```

- `--allow-host NAME` is repeatable. The server then accepts a `Host` header of exactly `NAME` or `NAME:<port>`, and a POST whose `Origin` is `https://NAME`, `http://NAME` or `http://NAME:<port>`. Every other `Host` and every other `Origin` is still refused with 403.
- `NAME` must be a plain DNS host name: letters, digits and `-` in dot-separated labels. A wildcard, an IP address, a port, a scheme or a path is refused and the server does not start (exit code 2).
- The server still binds `127.0.0.1` only. There is no option to bind another address.
- It prints one line at start naming the allowed hosts. **Use it only behind a private network such as Tailscale serve; never behind a public tunnel.** Anyone who can reach the host name can read the dashboard, and the dashboard has no login of its own.

## The usertrust mark (opt-in)

Off by default. When it is on, the header shows the usertrust mark beside the name, loaded from the usertrust website. The mark is not part of this package.

- **What is fetched:** one SVG, the usertrust website's own icon, `https://usertrust.ai/favicon.svg`. Nothing else.
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
