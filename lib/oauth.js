import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  // TikTok Desktop Login Kit expects HEX(SHA256(verifier)), not base64url
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
  return { verifier, challenge, method: 'S256' };
}

export function buildAuthUrl({ clientKey, redirectUri, scopes, state, codeChallenge }) {
  const q = new URLSearchParams({
    client_key: clientKey,
    response_type: 'code',
    scope: scopes.join(','),
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${q.toString()}`;
}

export function saveSession(sessionPath, session) {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

export function loadSession(sessionPath) {
  if (!fs.existsSync(sessionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function exchangeCode({
  clientKey,
  clientSecret,
  code,
  redirectUri,
  codeVerifier,
}) {
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(json)}`);
  }
  return json;
}
