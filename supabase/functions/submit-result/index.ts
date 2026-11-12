// PickleBall: Hyper - final result of an online match.
//
// Each player's app sends its own record of the match when it ends: the winner of
// every rally in order, the final score and the longest rally. This function
//   1. identifies the caller from their login token (never from the body),
//   2. replays the rally log against the scoring rules for the match's mode, 1 vs 1 or
//      2 vs 2 (supabase/functions/_shared/rules.ts),
//   3. stores the report through public.svc_submit_report (service role only), which
//      accepts the result only when EVERY player's valid report agrees, then updates
//      ratings and stats in one transaction. Reports that disagree void the match.
// The app never writes scores, ratings or stats itself.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkReport, parseReport } from '../_shared/rules.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'not_signed_in' }, 401);
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth?.user) return json({ error: 'not_signed_in' }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }
  const report = parseReport(body);
  if (!report) return json({ error: 'invalid_request' }, 400);

  // the match's mode decides which scoring rules apply (read from the database, not the body)
  const { data: match } = await admin.from('online_matches').select('mode').eq('id', report.match_id).maybeSingle();
  const mode = (match as { mode?: string } | null)?.mode === 'doubles' ? 'doubles' : 'singles';
  const check = checkReport(report, mode);
  const { data, error } = await admin.rpc('svc_submit_report', {
    p_match: report.match_id,
    p_user: auth.user.id,
    p_host_score: report.host_score,
    p_guest_score: report.guest_score,
    p_longest: report.longest_rally,
    p_winners: check.winners,
    p_valid: check.valid,
    p_reason: check.valid ? null : check.reason,
    p_last_point_ms: Math.round(check.lastT),
  });
  if (error) {
    console.error('svc_submit_report failed:', error.message);
    return json({ error: 'submit_failed' }, 500);
  }
  const outcome = (data ?? {}) as Record<string, unknown>;
  if (outcome.status === 'rejected') return json(outcome, 403);
  return json({ ...outcome, report_valid: check.valid, ...(check.valid ? {} : { invalid_reason: check.reason }) });
});
