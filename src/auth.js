const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value ?? ''))));
}

function constantTimeBytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function safeSecretEqual(a, b) {
  return constantTimeBytesEqual(await digest(a), await digest(b));
}

function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const entries = header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    });
  return Object.fromEntries(entries);
}

export async function createSession(env) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET não configurado.');
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ exp: Date.now() + 7 * 24 * 60 * 60 * 1000, nonce: crypto.randomUUID() })));
  const signature = bytesToBase64Url(await hmac(env.SESSION_SECRET, payload));
  return `${payload}.${signature}`;
}

export async function verifySession(request, env) {
  if (!env.SESSION_SECRET) return false;
  const token = parseCookies(request).gtrz_flow_session;
  if (!token) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;
  const expected = await hmac(env.SESSION_SECRET, payload);
  let supplied;
  try {
    supplied = base64UrlToBytes(signature);
  } catch {
    return false;
  }
  if (!constantTimeBytesEqual(expected, supplied)) return false;
  try {
    const data = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

export function sessionCookie(request, token, maxAge = 604800) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `gtrz_flow_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}
