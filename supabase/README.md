# Cloud save (Supabase)

Players can create an account (email and password) to save their profile and match history online and to see a leaderboard. Without an account the game still works offline, and finished matches are queued on the phone and uploaded after signing in.

| Data | Where | Create | Read | Update | Delete |
| --- | --- | --- | --- | --- | --- |
| Profile (name, look, paddle) | `profiles` table | first sign-in | on sign-in | saving Customize | Account → Delete my cloud data |
| Match history | `matches` table | every finished match | Match history screen | (results can't be edited) | ✕ on a match, Delete all |
| Leaderboard | `get_leaderboard()` function | | Leaderboard screen | | |

Row Level Security lets each player read and change only their own profile and matches. The leaderboard returns names and totals only.

## Setup

1. **Create the tables.** In the Supabase dashboard open **SQL Editor → New query**, paste the contents of `supabase/migrations/20261112000000_init.sql` and click **Run**. Running it again is safe.
2. **Environment variables.** Copy `.env.example` to `.env` (git-ignored) and fill in `SUPABASE_URL` (the project URL, with or without `/rest/v1/`) and `SUPABASE_PUBLISHABLE_KEY` (**Project Settings → API Keys**, the `sb_publishable_…` or legacy `anon` key). Never put the `secret` / `service_role` key there: everything in `.env` is built into the app, and the app refuses keys that look secret. After changing `.env`, restart Metro with `npm start -- --reset-cache`. For GitHub Actions, add the same two values as repository secrets.
3. **Registration with an email code (OTP).** The app asks for a code, not a link:
   1. Player enters email + password → **Create account**.
   2. Supabase emails a 6-digit code (template below).
   3. Player types the code → it's verified with `verifyOtp` → signed in.
   4. The database trigger creates the profile (with the player's in-game name) and the app uploads their look.
   5. The app returns to the main menu, ready to play.

   Dashboard settings:
   - **Authentication → Sign In / Providers → Email:** *Enable Email provider* ON, *Confirm email* ON (this is what sends the code), *Email OTP length* 6, *Email OTP expiration* e.g. 900 seconds.
   - **Authentication → Emails → Templates → Confirm signup:** subject `Your PickleBall: Hyper code: {{ .Token }}`, body = the contents of `supabase/templates/confirm-signup.html` (it shows `{{ .Token }}` and has no link).
   - **Authentication → Emails → SMTP Settings:** your own email service with *Sender name* `PickleBall: Hyper`. Supabase's built-in sender only delivers to your organization's team members, a few emails per hour, and can't change the sender name.

   **Fallback:** if email codes can't be sent, turn *Confirm email* OFF. Players are then signed in right after *Create account*; the app detects this automatically, no code change needed.

## Code

- `src/backend/api.ts`: the CRUD calls (auth, profile, matches, leaderboard)
- `src/backend/cloud.ts`: sign-in state, profile sync, offline match queue
- `src/ui/CloudScreens.tsx`: Account, Match history and Leaderboard screens
- `__tests__/backend.test.ts`: tests with a fake client (no network)

# Online play

Signed-in players can play each other in **1 vs 1** or **2 vs 2** (four real players): **Quick Match** (random opponents near their rating; 2 vs 2 teams are balanced by rating), **rooms** (a 6-letter code to share, or an invite to a friend; in 2 vs 2 rooms players pick their team), **friends** (added with an 8-letter friend code, with online status), plus online **match history** and an online **leaderboard** (Elo rating, one rating for both modes).

**Seats:** 0 = host (team A), 1 = team B, 2 = team A, 3 = team B (1 vs 1 uses seats 0 and 1). `host_score` / `guest_score` on a match are team A / team B, and `online_match_players` lists who played on which team.

## How a match runs

| Piece | What it does |
| --- | --- |
| Postgres functions (`*_online_multiplayer.sql`) | rooms, ready / start, Quick Match pairing, friends, invites, heartbeats, forfeits, stats and ratings. Players can only **read** their own rows; every change goes through these functions. |
| Realtime Broadcast (private channels) | the match itself: `match:<id>` (only the host sends: snapshots and events) and `match:<id>:<player id>` (only that player sends: their inputs; only the host listens). So nobody can send messages that look like another player's. `user:<id>` and `room:<id>` get "something changed" notices from the database |
| Realtime Presence | `lobby`: who is online (for the friends list) |
| Edge Function `submit-result` | each phone sends its own record of the match; the server replays it against the rules of the match's mode and counts it only when **every** player's record agrees |

The **host's phone runs the match** (physics, rules, score): every other phone sends only its own position, shot taps and Hyper taps, and draws the host's match (team B mirrored, so everyone sees themselves at the bottom). The host never trusts their input: positions are speed-limited and kept on that player's side of the court, and shots follow the same rules as the host's own. Every player has their own Hyper meter.

Clients **never write scores, results, ratings or stats**. The server:
- replays the winner of every rally and checks the final score (only the server scores, 11 and win by 2; in 2 vs 2 the "0-0-2" start and first / second server),
- refuses a match "longer" than the server's own clock allows,
- accepts the result only when every player's report is valid and identical (otherwise the match is *disputed* and doesn't count),
- decides forfeits from its own heartbeat timestamps (a player silent for 30 s+ loses the match for their team when the other side claims it; if players on both teams are gone nobody wins).

**Limit of this design:** the host's phone is trusted to simulate fairly. A modified host app could still bend the physics during play (both reports would then agree). For ranked play with real stakes, move the simulation to a dedicated server (the protocol in `src/game/net.ts` already separates inputs from state, so a Node server can take the host role without changing the guest).

**Disconnects:** if anyone's messages stop for 2.5 s the match pauses for everyone ("Waiting for <name>…"); it continues when they're back. After 40 s the other side can claim the win; the server only allows it if the missing player's heartbeat is really 30 s+ old. A host whose app restarts resumes from the last rally (saved on the phone); a guest who reconnects is caught up by the next snapshot.

## Setup

Run `supabase/migrations/20261112100000_online_multiplayer.sql`, `20261112110000_online_fixes.sql` and `20261112120000_online_doubles.sql` in the SQL Editor, in that order (all are safe to re-run), and deploy `supabase/functions/submit-result` (it uses `_shared/rules.ts`).

## Code

- `src/game/net.ts`: the wire protocol (messages, mirroring, validation)
- `src/game/engine.ts`: host / guest roles (`startOnline`, `netReceive`, …)
- `src/backend/online/api.ts`: database functions + Edge Function calls
- `src/backend/online/session.ts`: online lobby state, Realtime channels (each opened once), Quick Match
- `src/backend/online/netplay.ts`: one match: channel, heartbeat, disconnects, forfeit, result
- `src/ui/OnlineScreens.tsx`: Online hub, room lobby, Quick Match, friends, history, ranking, in-match menu and result
- `__tests__/online.test.ts`: rules + two or four engines over an in-memory link (full 1 vs 1 and 2 vs 2 matches, desync checks)
- `__tests__/online.live.test.ts`: two real accounts on the real backend: `PBH_LIVE=1 npx jest __tests__/online.live.test.ts --runInBand --forceExit` (creates `pbh-live-a@example.com` … `pbh-live-d@example.com`; passwords in the git-ignored `.env.test`)
