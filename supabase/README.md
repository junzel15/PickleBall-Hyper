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
