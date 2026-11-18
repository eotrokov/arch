// OAuth Authorization Code + PKCE (S256). Токен здесь не хранится.
import type { EditorConfig } from '../config.js';

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  // 256 делится на 64 без остатка — смещения нет
  const verifier = Array.from(bytes, (b) => ALPHABET[b % 64]).join('');
  return { verifier, challenge: await challengeFor(verifier) };
}

export function authorizeUrl(cfg: EditorConfig, challenge: string, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.oauthClientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'api',
  });
  return `${cfg.gitlabUrl}/oauth/authorize?${q.toString()}`;
}

export async function exchangeCode(cfg: EditorConfig, code: string, verifier: string, fetchFn: typeof fetch): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.oauthClientId,
    code_verifier: verifier,
  });
  const res = await fetchFn(`${cfg.gitlabUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? `обмен кода не удался (HTTP ${res.status})`);
  }
  return data.access_token;
}
