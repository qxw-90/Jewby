import fs from 'node:fs';

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const map = {};
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return map;
}

function upsertEnvKeys(filePath, updates) {
  const exists = fs.existsSync(filePath);
  const lines = exists ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/) : [];
  const keys = new Set(Object.keys(updates));
  const seen = new Set();

  const next = lines.map((line) => {
    const idx = line.indexOf('=');
    if (idx < 1) return line;
    const key = line.slice(0, idx).trim();
    if (!keys.has(key)) return line;
    seen.add(key);
    return `${key}=${updates[key] ?? ''}`;
  });

  for (const key of keys) {
    if (!seen.has(key)) next.push(`${key}=${updates[key] ?? ''}`);
  }

  const content = `${next.filter((line, i, arr) => !(line === '' && i === arr.length - 1)).join('\n').replace(/\n*$/, '\n')}`;
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

/**
 * Compare tokens with both env files; only replace when different.
 * Returns a summary of what changed (without token values).
 */
export function syncTokensToEnvFiles(envPaths, { accessToken, refreshToken, expiresIn }) {
  const results = [];

  for (const envPath of envPaths) {
    const current = readEnvFile(envPath);
    const accessChanged = (current.TIKTOK_ACCESS_TOKEN || '') !== (accessToken || '');
    const refreshChanged = (current.TIKTOK_REFRESH_TOKEN || '') !== (refreshToken || '');

    if (accessChanged || refreshChanged) {
      const updates = {};
      if (accessChanged) updates.TIKTOK_ACCESS_TOKEN = accessToken || '';
      if (refreshChanged) updates.TIKTOK_REFRESH_TOKEN = refreshToken || '';
      if (expiresIn != null) updates.TIKTOK_ACCESS_TOKEN_EXPIRES_IN = String(expiresIn);
      upsertEnvKeys(envPath, updates);
    }

    results.push({
      path: envPath,
      access_token_updated: accessChanged,
      refresh_token_updated: refreshChanged,
      changed: accessChanged || refreshChanged,
    });
  }

  return results;
}

export function loadCredentialsFromEnv(envPath) {
  return readEnvFile(envPath);
}

export function hasValidTokens(envPath) {
  const env = readEnvFile(envPath);
  return Boolean(env.TIKTOK_ACCESS_TOKEN);
}
