#!/usr/bin/env node
/**
 * Configures Supabase Auth for PickleBall: Hyper through the Supabase Management API:
 *   - email sign-up with a 6-digit code (Confirm email ON, OTP length 6, 15 min expiry)
 *   - custom SMTP through Resend with the sender name "PickleBall: Hyper"
 *   - the branded "Confirm signup" template (supabase/templates/confirm-signup.html)
 *
 * Secrets are read from supabase/.secrets.local (git-ignored) and never printed.
 * Usage: node supabase/configure-auth.mjs            (apply)
 *        node supabase/configure-auth.mjs --check    (only show the current settings)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT_REF = 'wmceflszyovlkyxggzif';
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`;

function readSecrets() {
  const out = {};
  const text = readFileSync(join(here, '.secrets.local'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const s = readSecrets();
const missing = ['SUPABASE_ACCESS_TOKEN', 'RESEND_API_KEY', 'SENDER_EMAIL'].filter(k => !s[k]);
const checkOnly = process.argv.includes('--check');
if (!s.SUPABASE_ACCESS_TOKEN) {
  console.error('Missing SUPABASE_ACCESS_TOKEN in supabase/.secrets.local');
  process.exit(1);
}
if (!checkOnly && missing.length) {
  console.error(`Missing in supabase/.secrets.local: ${missing.join(', ')}`);
  process.exit(1);
}
if (!checkOnly && !/^re_/.test(s.RESEND_API_KEY)) {
  console.error('RESEND_API_KEY should start with "re_".');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${s.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };

async function call(method, body) {
  const res = await fetch(API, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) {
    // never echo request bodies (they contain secrets); the API's error text doesn't
    console.error(`${method} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : {};
}

function summary(c) {
  return {
    'Email sign-in enabled': c.external_email_enabled,
    'Confirm email (sends the code)': c.mailer_autoconfirm === false,
    'OTP length': c.mailer_otp_length,
    'OTP expiry (s)': c.mailer_otp_exp,
    'SMTP host': c.smtp_host || '(Supabase built-in)',
    'SMTP port': c.smtp_port,
    'SMTP user': c.smtp_user,
    'SMTP password set': Boolean(c.smtp_pass),
    'Sender email': c.smtp_admin_email,
    'Sender name': c.smtp_sender_name,
    'Email rate limit / hour': c.rate_limit_email_sent,
    'Min. seconds between emails (resend wait)': c.smtp_max_frequency,
    'Confirm signup subject': c.mailer_subjects_confirmation,
    'Template shows code {{ .Token }}': /\{\{\s*\.Token\s*\}\}/.test(c.mailer_templates_confirmation_content || ''),
    'Template contains a link': /ConfirmationURL/.test(c.mailer_templates_confirmation_content || ''),
  };
}

if (checkOnly) {
  console.table(summary(await call('GET')));
  process.exit(0);
}

const template = readFileSync(join(here, 'templates', 'confirm-signup.html'), 'utf8')
  .replace(/<!--[\s\S]*?-->\s*/, ''); // drop the setup comment at the top

await call('PATCH', {
  external_email_enabled: true,
  mailer_autoconfirm: false, // "Confirm email" ON: new accounts get a code
  mailer_otp_length: 6,
  mailer_otp_exp: 900,
  smtp_host: 'smtp.resend.com',
  smtp_port: '465',
  smtp_user: 'resend',
  smtp_pass: s.RESEND_API_KEY,
  smtp_admin_email: s.SENDER_EMAIL,
  smtp_sender_name: 'PickleBall: Hyper',
  rate_limit_email_sent: 30,
  mailer_subjects_confirmation: 'Your PickleBall: Hyper code: {{ .Token }}',
  mailer_templates_confirmation_content: template,
});

console.log('Saved. Current settings:');
console.table(summary(await call('GET')));
