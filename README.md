# Hit Board — Autonomous Squad

The 9 bots live here, on GitHub's servers, picking and revising without you.

## What runs, and when
A GitHub Actions cron fires **every 30 minutes, 10am–3:30am ET**. Each run:
1. Settles yesterday's (and any missed) results from official box scores
2. Rebuilds today's board (MLB API + Savant + DraftKings via The Odds API)
3. Scans the wire: r/fantasybaseball, r/baseball, MLB.com / ESPN / RotoWire news feeds, Bluesky
4. Bots file their cards (once prices/lineups exist) and **revise them** — a pick who's
   scratched, IL'd, or missing from the posted lineup gets swapped for the next-best
   qualifier, but ONLY before that game's first pitch. Every change is logged to the wire
   with the reason.
5. Writes the ledger to your jsonbin — the same bin your dashboard syncs. Open the site
   on your phone anytime; the standings, picks, and wire are already up to date.

## Setup (~10 minutes, once)
1. Create a **public** GitHub repo (public = unlimited free Actions minutes) and upload
   this folder's contents, keeping the `.github/workflows/` path intact.
2. Repo → Settings → Secrets and variables → Actions → add:
   - `JSONBIN_KEY` — your jsonbin.io master key (same one in the dashboard)
   - `JSONBIN_BIN` — your sync code / bin id (shown in the dashboard's cloud-sync box)
   - `ODDS_API_KEY` — your the-odds-api.com key (bots need prices; Mitts & Fadey are
     price-driven). NOTE: 48 runs/day × ~15 events exceeds the free 500/month tier —
     the runner only fetches odds once meaningful, but budget for the $30/mo tier or
     reduce the cron to hourly.
   - `ANTHROPIC_API_KEY` — optional. Adds a Claude Haiku comprehension pass that
     confirms/denies keyword news hits (cuts false scratches from ambiguous headlines).
     Without it, the keyword engine runs alone. Cost: fractions of a cent per run.
3. Actions tab → enable workflows → hit **Run workflow** once to test. Green check +
   your dashboard's wire updating = alive.

## Ground rules encoded
- A pick is revisable until its game's first pitch, then frozen forever.
- Bots never pick a player who is news-flagged or already started.
- Every revision hits the wire: who, out, why, and the replacement.
- Settlement matches the dashboard exactly (win = 1+ hit; 0-PA appearance = push).

## Honest limits
- Twitter/X is not scanned (their API pricing makes it impractical); Bluesky + Reddit +
  news RSS cover most beat-reporter signal.
- Spin-trend analysis is skipped server-side (too many Statcast pulls per run).
- The keyword engine can miss cleverly-worded news; the Claude layer helps but neither
  is a guarantee. A missed scratch settles as a push, not a loss, so the damage is bounded.
