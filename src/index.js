import { handleAdminApi } from './api.js';
import { handleQueue, handleWebhook, handleWebhookVerification } from './webhook.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

function errorMessage(error) { return String(error?.message || error || 'Erro inesperado'); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/webhooks/instagram' && request.method === 'GET') return handleWebhookVerification(request, env);
      if (url.pathname === '/webhooks/instagram' && request.method === 'POST') return handleWebhook(request, env);
      if (url.pathname.startsWith('/api/')) return handleAdminApi(request, env, url.pathname);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ scope: 'fetch', path: url.pathname, error: errorMessage(error) }));
      return json({ ok: false, error: errorMessage(error) }, 500);
    }
  },
  async queue(batch, env) {
    return handleQueue(batch, env);
  },
};
