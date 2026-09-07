import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';

import {
  buildAuthUrl,
  createPkcePair,
  exchangeCode,
  loadSession,
  saveSession,
} from './lib/oauth.js';
import {
  hasValidTokens,
  loadCredentialsFromEnv,
  syncTokensToEnvFiles,
} from './lib/env-sync.js';
import { publishStatus, publishVideo } from './lib/publisher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PROJECT_ROOT = path.resolve(ROOT, '..');
const TIKTOK_DIR = path.join(PROJECT_ROOT, 'TikTok');
const TIKTOK1_DIR = path.join(PROJECT_ROOT, 'TikTok1');
const ENV_PATHS = [
  path.join(TIKTOK_DIR, '.env'),
  path.join(TIKTOK1_DIR, '.env'),
];
const PRIMARY_ENV = ENV_PATHS[0];
const SESSION_PATH = path.join(ROOT, '.agent-data', '.tiktok-oauth-session.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

const PORT = Number(process.env.PORT || 8787);
const REDIRECT_URI =
  process.env.TIKTOK_REDIRECT_URI || `http://localhost:${PORT}/callback`;

/**
 * Scopes must be enabled for this app in the developer portal
 * (Login Kit + Content Posting API).
 * Override via TikTok/.env: TIKTOK_SCOPES=user.info.basic,video.upload
 */
function resolveScopes() {
  const fromEnv =
    process.env.TIKTOK_SCOPES ||
    loadCredentialsFromEnv(PRIMARY_ENV).TIKTOK_SCOPES ||
    '';
  const list = String(fromEnv)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length
    ? list
    : ['user.info.basic', 'video.upload'];
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });

function getAppCredentials() {
  const env = loadCredentialsFromEnv(PRIMARY_ENV);
  const clientKey = process.env.TIKTOK_CLIENT_KEY || env.TIKTOK_CLIENT_KEY || '';
  const clientSecret =
    process.env.TIKTOK_CLIENT_SECRET || env.TIKTOK_CLIENT_SECRET || '';
  if (!clientKey || !clientSecret) {
    throw new Error(
      'Missing TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET in TikTok/.env',
    );
  }
  return { clientKey, clientSecret };
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-()+ ]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype.startsWith('video/') ||
      file.mimetype.startsWith('image/') ||
      /\.(mp4|mov|webm|avi|jpg|jpeg|png|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only video or image files are allowed'), ok);
  },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/status', (_req, res) => {
  try {
    const loggedIn = hasValidTokens(PRIMARY_ENV);
    const env = loadCredentialsFromEnv(PRIMARY_ENV);
    res.json({
      ok: true,
      logged_in: loggedIn,
      dry_run: (env.TIKTOK_DRY_RUN || 'true').toLowerCase() !== 'false',
      requested_scopes: resolveScopes(),
      post_mode: env.TIKTOK_POST_MODE || 'DIRECT_POST',
      redirect_uri: REDIRECT_URI,
      env_files: ENV_PATHS.map((p) => ({
        path: p,
        has_access_token: Boolean(loadCredentialsFromEnv(p).TIKTOK_ACCESS_TOKEN),
        has_refresh_token: Boolean(
          loadCredentialsFromEnv(p).TIKTOK_REFRESH_TOKEN,
        ),
      })),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

/** Check whether current token can call Content Posting (creator_info). Never returns token values. */
app.get('/api/token-check', async (_req, res) => {
  try {
    const env = loadCredentialsFromEnv(PRIMARY_ENV);
    const token = env.TIKTOK_ACCESS_TOKEN || '';
    if (!token) {
      res.json({
        ok: false,
        logged_in: false,
        can_publish: false,
        error: 'No access token. Please click Scan & authorize first.',
      });
      return;
    }

    const r = await fetch(
      'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: '{}',
      },
    );
    const json = await r.json();
    const code = json?.error?.code || '';
    const message = json?.error?.message || '';

    if (code === 'ok' || r.ok) {
      res.json({
        ok: true,
        logged_in: true,
        can_publish: true,
        tip: 'Token has Content Posting permission. You can upload.',
      });
      return;
    }

    res.json({
      ok: false,
      logged_in: true,
      can_publish: false,
      tiktok_error: code,
      message,
      tip:
        code === 'scope_not_authorized'
          ? 'Token missing video.upload / video.publish. Re-authorize after enabling Content Posting API in the developer portal.'
          : 'Token check failed. Re-login or verify sandbox Target Users.',
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.get('/api/auth/start', (req, res) => {
  try {
    const { clientKey } = getAppCredentials();
    const scopes = resolveScopes();
    const pkce = createPkcePair();
    const state = crypto.randomUUID();

    saveSession(SESSION_PATH, {
      state,
      redirectUri: REDIRECT_URI,
      codeVerifier: pkce.verifier,
      scopes,
      createdAt: new Date().toISOString(),
    });

    const authUrl = buildAuthUrl({
      clientKey,
      redirectUri: REDIRECT_URI,
      scopes,
      state,
      codeChallenge: pkce.challenge,
    });

    if (req.query.json === '1') {
      res.json({ ok: true, auth_url: authUrl });
      return;
    }
    res.redirect(authUrl);
  } catch (error) {
    res.status(500).send(`Auth start failed: ${error.message}`);
  }
});

app.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    res.redirect(
      `/?auth=error&message=${encodeURIComponent(String(errorDescription || error))}`,
    );
    return;
  }

  try {
    const session = loadSession(SESSION_PATH);
    if (!session?.codeVerifier) {
      throw new Error('Missing OAuth session. Please click Login again.');
    }
    if (!code || state !== session.state) {
      throw new Error('Invalid OAuth callback (missing code or bad state).');
    }

    const { clientKey, clientSecret } = getAppCredentials();
    const tokenJson = await exchangeCode({
      clientKey,
      clientSecret,
      code: String(code),
      redirectUri: session.redirectUri || REDIRECT_URI,
      codeVerifier: session.codeVerifier,
    });

    const grantedScope = String(tokenJson.scope || '');
    const syncResult = syncTokensToEnvFiles(ENV_PATHS, {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token || '',
      expiresIn: tokenJson.expires_in,
    });

    const updated = syncResult.filter((r) => r.changed).length;
    const unchanged = syncResult.length - updated;
    const scopes = grantedScope.split(/[,\s]+/).filter(Boolean);
    const hasPublish = scopes.includes('video.publish');
    const hasUpload = scopes.includes('video.upload');

    res.redirect(
      `/?auth=success&updated=${updated}&unchanged=${unchanged}` +
        `&open_id=${encodeURIComponent(tokenJson.open_id || '')}` +
        `&scope=${encodeURIComponent(grantedScope)}` +
        `&has_publish=${hasPublish ? '1' : '0'}` +
        `&has_upload=${hasUpload || hasPublish ? '1' : '0'}`,
    );
  } catch (err) {
    res.redirect(
      `/?auth=error&message=${encodeURIComponent(String(err.message || err))}`,
    );
  }
});

app.post('/api/publish', upload.single('media'), async (req, res) => {
  try {
    if (!hasValidTokens(PRIMARY_ENV)) {
      res.status(401).json({
        ok: false,
        error: 'Not logged in. Please scan QR / authorize first.',
      });
      return;
    }
    if (!req.file) {
      res.status(400).json({ ok: false, error: 'Please choose a video or photo file.' });
      return;
    }

    const caption = String(req.body.caption || '').trim();
    const title = String(req.body.title || caption || path.parse(req.file.originalname).name).trim();
    const isImage = req.file.mimetype.startsWith('image/');
    const mediaType = isImage ? 'PHOTO' : 'VIDEO';

    // MCP equivalent: tiktok_publish_video
    const result = await publishVideo(TIKTOK_DIR, {
      videoPath: req.file.path,
      caption,
      title,
      mediaType,
    });

    const payload = result.json || { raw: result.stdout };
    const publishId =
      payload?.result?.platformPostId ||
      payload?.result?.raw?.publish_id ||
      payload?.result?.raw?.jobId ||
      payload?.job?.id ||
      null;

    res.json({
      ok: true,
      tool: 'tiktok_publish_video',
      media_type: mediaType,
      file_name: req.file.originalname,
      publish_id: publishId,
      result: payload,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      tool: 'tiktok_publish_video',
      error: String(error.message || error),
    });
  }
});

app.get('/api/publish/status', async (req, res) => {
  try {
    const publishId = String(req.query.id || '').trim();
    if (!publishId) {
      res.status(400).json({ ok: false, error: 'Missing publish id' });
      return;
    }

    // MCP equivalent: tiktok_publish_status
    const result = await publishStatus(TIKTOK_DIR, publishId);
    const payload = result.json || { raw: result.stdout };

    const status =
      payload?.status ||
      payload?.data?.status ||
      payload?.result?.status ||
      (payload?.dryRun ? 'DRY_RUN' : 'UNKNOWN');

    const successStatuses = new Set([
      'PUBLISH_COMPLETE',
      'PUBLISHED',
      'SUCCESS',
      'DRY_RUN',
      'PROCESSING_DOWNLOAD',
      'PROCESSING_UPLOAD',
    ]);

    res.json({
      ok: true,
      tool: 'tiktok_publish_status',
      publish_id: publishId,
      status,
      success: successStatuses.has(String(status).toUpperCase()) || payload?.dryRun === true,
      result: payload,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      tool: 'tiktok_publish_status',
      error: String(error.message || error),
    });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Jewby running at http://localhost:${PORT}`);
  console.log(`OAuth callback: ${REDIRECT_URI}`);
  console.log(`Syncing tokens to:\n  - ${ENV_PATHS[0]}\n  - ${ENV_PATHS[1]}`);
});
