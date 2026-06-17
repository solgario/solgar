# solgar — multiplayer

Agar.io-style game with a **hybrid client**: open `index.html` and it plays immediately offline vs
bots; once it can reach this server it switches to **live multiplayer** automatically. The server runs
the whole multiplayer simulation (authoritative — clients send only their input, so they can't cheat by
editing speed/size locally) and also serves the client file.

All five files live at the **project root** (no subfolders): `index.html`, `server.js`, `package.json`,
`README.md`, `.gitignore`. Keep them together when you upload to a host.

## The lobby (bot-fill floor + player cap)
- The arena always has at least **20 participants** (`MIN_POP`) — bots pad it out.
- It boots with **20 bots**.
- When a real player joins, **one bot is removed** and the player spawns **fresh at starting mass** —
  the bot's accumulated mass is **discarded** (not dropped as food, not given to the joiner).
- Past 20 real players, more join as pure additions up to the **80-player cap** (`MAX_PLAYERS`); a join beyond that gets a `full` message and can spectate instead.
- When a real player leaves or dies, a **bot refills** the floor, so it never feels empty.
- **Spectators** (token-less viewers) connect with no slot and no cell — they watch the leader. Rounds are **10 minutes**; the top 5 are broadcast at each round end.

## Run locally
```bash
npm install
npm start
# open http://localhost:3000
```
Open multiple browser tabs to watch real players replace bots in the leaderboard.

## Host it (get a public URL)

You need a host that runs **Node.js + WebSockets** and stays running (not a static-only/serverless host).
Two good options in 2026:

### Option A — Render (free, recommended to start)
No credit card. Free web services sleep after 15 min of no traffic and take ~1 min to wake, but
WebSocket traffic keeps them awake, so while people are actually playing it stays up.
1. Put these files in a GitHub repo (see "Getting code to GitHub" below).
2. render.com → **New → Web Service** → connect the repo.
3. Runtime **Node**, Build command `npm install`, Start command `npm start`. (Render usually fills these in.)
4. Instance type **Free** → Create. Render injects `PORT`; the server already reads it.
5. Open the `…onrender.com` URL it gives you. The client auto-connects over `wss://` on that same domain.

### Option B — Railway (paid, ~$5/mo Hobby after the trial credit)
1. Repo on GitHub (below).
2. railway.com → **New Project → Deploy from GitHub repo** → pick the repo.
3. It auto-detects Node, runs `npm install` then `npm start` — no build config.
4. In **Settings → Networking**, generate a **public domain**, then open it.

Both serve the page and the WebSocket on the **same domain/port**, so there's nothing else to wire up.

### Just want a free single-player link to share?
Because the client plays offline vs bots on its own, you can drop **only `index.html`** on a static host
(Netlify drag-and-drop, Vercel, or GitHub Pages) for a zero-cost shareable game. Visitors play vs bots;
there's no shared multiplayer without the Node server above.

## Getting code to GitHub (works from a phone)
1. github.com → sign in → **New repository** → name it (e.g. `solgar`) → Create.
2. On the repo page: **Add file → Upload files** → select all five files → **Commit changes**.
   (They're all at the root now, so there are no folders to recreate — just upload them together.)
3. Connect that repo in Render or Railway above. Every push auto-redeploys.

## Tuning (top of `server.js`)
`MIN_POP` (bot floor), `MAX_PLAYERS` (real cap), `WORLD`, `FOOD_COUNT`, `ROUND_LENGTH` (seconds), `TICK_HZ`, `SEND_HZ`.

## Token gate ($SOLGAR)
The gate is **off until you set the token mint**, so everything works in the pre-mint demo. To turn it on,
set environment variables on your host (Render/Railway → service → Environment):
- `SOLGAR_MINT` — the token's mint address. Setting this **enables** the gate.
- `MIN_HOLD` — required balance (default `250000`).
- `SOLANA_RPC` — an RPC URL. The default public one is rate-limited; for real traffic use a free Helius/QuickNode key.

How it works: the player clicks **Connect Wallet** (Phantom), signs a short message proving they own it,
and that proof rides along with `join`. The server verifies the signature, then reads the wallet's on-chain
$SOLGAR balance; if it's `>= MIN_HOLD` they're let in, otherwise they get a "need 250k" message and can still
spectate. The verified address is stored on the connection (`ws.wallet`) — that's the address you'd pay rewards to.

Notes: it uses the standard SPL Token program (what pump.fun mints use). Wallet connect needs the Phantom
extension on desktop, or opening the page **inside the Phantom mobile app's browser** — a normal phone browser
won't have a wallet injected. Full mobile deep-linking is a later add.

## Paying winners (manual, no treasury on the server)
This build does **not** auto-send SOL — no private key ever touches the server, which is the whole point.
Instead, at the end of every round the server records the top 5 and their verified wallet addresses, and
shows them on a private page so you can send the SOL yourself from Phantom.

- Set an `ADMIN_KEY` env var (any long random string) to enable the page.
- Open `https://your-app.onrender.com/payouts?key=YOUR_ADMIN_KEY` — it lists recent rounds with each
  winner's rank, split %, name, mass, and **wallet address** (copy-friendly). Bots and players who didn't
  connect a wallet are flagged as not payable.
- Add `&pool=2.5` to auto-split a SOL pool across the five winners (35/25/15/10/5%), so the page shows the
  exact amount to send each address. Then you send them manually.
- Winners are also printed to the server logs each round (visible in the Render dashboard).

For a wallet to be captured, the player must connect one — required when the gate is on, optional (but
needed to be payable) when it's off.

## What this is / isn't
This is a solid **baseline**: authoritative sim, per-client viewport culling, client-side interpolation,
the bot-fill lobby, rounds, viruses, split/eject/merge, spawn shield, lethal edge, crown, leaderboard.

Before production you'll likely want: input sequence numbers + reconciliation, delta-compressed or binary
snapshots, rate-limiting/validation on inputs, a real matchmaking/room layer (one process = one 20-player
arena; run several behind a router for scale), and reconnection handling. The token-gate (check a wallet's
$SOLGAR balance before allowing `join`) slots in at the `joinReal` step on the server.
