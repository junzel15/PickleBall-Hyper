// PickleBall: Hyper - player registration without email confirmation.
//
// Creates the account as already confirmed through the Auth admin API, so Supabase
// never sends an email, whatever the "Confirm email" setting is. The app then signs
// the player in with signInWithPassword. The service-role key only exists here, on
// the server (Supabase provides it to Edge Functions); it is never in the app.
//
// Deployed with verify_jwt = false: players aren't signed in yet when they register
// (like Supabase's own /signup endpoint). The function validates its input and can
// only create accounts.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }

  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  const name = String(body?.name ?? '').slice(0, 40);

  if (!EMAIL.test(email) || email.length > 254) return json({ error: 'invalid_email' }, 400);
  if (password.length < 6 || password.length > 72) return json({ error: 'weak_password' }, 400);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // no confirmation email, ever
    user_metadata: name ? { name } : {},
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === 'email_exists' || /already|exists|registered/i.test(error.message)) {
      return json({ error: 'email_exists' }, 409);
    }
    if (code === 'weak_password') return json({ error: 'weak_password' }, 400);
    console.error('register failed:', error.message);
    return json({ error: 'register_failed' }, 500);
  }

  return json({ ok: true }, 201);
});
