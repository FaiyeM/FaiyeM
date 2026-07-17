/**
 * Single Cloudflare Worker backing two things on the site:
 *   POST /mitra    - proxies the Mitra terminal to the Anthropic API (key stays server-side)
 *   POST /contact  - sends the CV & Links form to Faye via Resend (no email exposed client-side)
 *
 * Deploy (free tier is enough):
 *   1. npm create cloudflare@latest mitra-worker  (or paste this file into the CF dashboard editor)
 *   2. Set secrets:  wrangler secret put ANTHROPIC_API_KEY
 *                    wrangler secret put RESEND_API_KEY
 *                    wrangler secret put CONTACT_TO          // your real inbox, never shipped to the client
 *   3. Optionally set var ALLOWED_ORIGIN to your site origin, e.g. https://faye.au
 *   4. In the site HTML, set CONFIG.MITRA_ENDPOINT and CONFIG.CONTACT_ENDPOINT to this worker's URLs.
 */

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1000;

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid JSON' }, 400, env);
    }

    if (url.pathname === '/mitra') {
      // Accept only messages + system from the client; pin model and token caps here.
      const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : null;
      if (!messages || !messages.length) return json({ error: 'messages required' }, 400, env);

      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: typeof body.system === 'string' ? body.system.slice(0, 8000) : undefined,
          messages,
        }),
      });
      const data = await upstream.json();
      return json(data, upstream.status, env);
    }

    if (url.pathname === '/contact') {
      const email = typeof body.email === 'string' ? body.email.trim().slice(0, 200) : '';
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 5000) : '';
      if (!email || !message) return json({ error: 'email and message required' }, 400, env);

      const upstream = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          // Use a verified domain sender once configured in Resend; onboarding@resend.dev works for testing.
          from: env.CONTACT_FROM || 'Faye Site <onboarding@resend.dev>',
          to: [env.CONTACT_TO],
          reply_to: email,
          subject: 'Site contact form',
          text: `From: ${email}\n\n${message}`,
        }),
      });
      if (!upstream.ok) return json({ error: 'send failed' }, 502, env);
      return json({ ok: true }, 200, env);
    }

    return json({ error: 'not found' }, 404, env);
  },
};
