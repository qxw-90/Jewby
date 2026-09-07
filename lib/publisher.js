import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { loadCredentialsFromEnv } from './env-sync.js';

const BASE = 'https://open.tiktokapis.com';

function contentTypeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function resolvePrivacyLevel(creatorInfo, desired = 'SELF_ONLY') {
  const allowed = creatorInfo?.data?.privacy_level_options;
  if (!Array.isArray(allowed) || allowed.length === 0) return desired;
  if (allowed.includes(desired)) return desired;
  if (allowed.includes('SELF_ONLY')) return 'SELF_ONLY';
  return allowed[0];
}

async function tiktokJson(accessToken, method, endpoint, body) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`TikTok response is not JSON: ${text.slice(0, 300)}`);
  }
  const code = json?.error?.code;
  if (!res.ok || (code && code !== 'ok')) {
    const err = new Error(
      `TikTok API ${res.status}: ${JSON.stringify(json).slice(0, 500)}`,
    );
    err.status = res.status;
    err.code = code || '';
    err.payload = json;
    throw err;
  }
  return json;
}

/**
 * Direct Post with local FILE_UPLOAD — no Supabase required.
 * Same TikTok Content Posting API used by MCP tiktok_publish_video,
 * but uploads the file from disk instead of PULL_FROM_URL.
 */
export async function publishVideo(tiktokProjectDir, { videoPath, caption, title, mediaType }) {
  const env = loadCredentialsFromEnv(path.join(tiktokProjectDir, '.env'));
  const dryRun = String(env.TIKTOK_DRY_RUN || 'true').toLowerCase() !== 'false';
  const accessToken = env.TIKTOK_ACCESS_TOKEN || '';
  const privacyDesired = env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY';

  if (dryRun) {
    const id = `dryrun_${Date.now()}`;
    return {
      json: {
        ok: true,
        dry_run: true,
        tool: 'tiktok_publish_video',
        mode: 'FILE_UPLOAD_DIRECT_POST',
        result: {
          provider: 'tiktok_official_local',
          platformPostId: id,
          raw: { dryRun: true },
        },
      },
    };
  }

  if (!accessToken) {
    throw new Error('Missing TIKTOK_ACCESS_TOKEN. Please re-authorize TikTok.');
  }
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`Media file not found: ${videoPath}`);
  }

  const type = String(mediaType || 'VIDEO').toUpperCase();
  if (type === 'PHOTO') {
    throw new Error(
      'Photo Direct Post requires a verified public HTTPS URL (PULL_FROM_URL). ' +
        'Please upload a video for local FILE_UPLOAD, or configure PUBLIC_MEDIA_BASE_URL.',
    );
  }

  const stat = fs.statSync(videoPath);
  const captionText = String(caption || title || '').trim().slice(0, 2200);

  // 1) creator info (required by Direct Post UX rules)
  const creatorInfo = await tiktokJson(
    accessToken,
    'POST',
    '/v2/post/publish/creator_info/query/',
    {},
  );
  const privacyLevel = resolvePrivacyLevel(creatorInfo, privacyDesired);

  // 2) init Direct Post with FILE_UPLOAD
  let init;
  try {
    init = await tiktokJson(
      accessToken,
      'POST',
      '/v2/post/publish/video/init/',
      {
        post_info: {
          title: captionText || 'Jewby post',
          privacy_level: privacyLevel,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: stat.size,
          chunk_size: stat.size,
          total_chunk_count: 1,
        },
      },
    );
  } catch (error) {
    if (error.code === 'unaudited_client_can_only_post_to_private_accounts') {
      throw new Error(
        'Unaudited apps can only post to private TikTok accounts. In the TikTok app: Profile → Menu → Settings and privacy → Privacy → turn on Private account, ' +
          'then try publishing again. To post to a public account, submit an App Audit in the developer console. ' +
          'See https://developers.tiktok.com/doc/content-sharing-guidelines/',
      );
    }
    throw error;
  }

  const publishId = init?.data?.publish_id;
  const uploadUrl = init?.data?.upload_url;
  if (!publishId || !uploadUrl) {
    throw new Error(
      `TikTok init missing publish_id/upload_url: ${JSON.stringify(init).slice(0, 400)}`,
    );
  }

  // 3) upload local file
  const buffer = fs.readFileSync(videoPath);
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentTypeForFile(videoPath),
      'Content-Length': String(stat.size),
      'Content-Range': `bytes 0-${stat.size - 1}/${stat.size}`,
    },
    body: buffer,
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`TikTok upload failed ${putRes.status}: ${text.slice(0, 400)}`);
  }

  return {
    json: {
      ok: true,
      dry_run: false,
      tool: 'tiktok_publish_video',
      mode: 'FILE_UPLOAD_DIRECT_POST',
      privacy_level: privacyLevel,
      result: {
        provider: 'tiktok_official_local',
        platformPostId: publishId,
        raw: init,
      },
    },
  };
}

export async function publishStatus(tiktokProjectDir, publishId) {
  const env = loadCredentialsFromEnv(path.join(tiktokProjectDir, '.env'));
  const dryRun = String(env.TIKTOK_DRY_RUN || 'true').toLowerCase() !== 'false';
  const accessToken = env.TIKTOK_ACCESS_TOKEN || '';

  if (dryRun || String(publishId).startsWith('dryrun_')) {
    return {
      json: {
        dryRun: true,
        publishId,
        status: 'DRY_RUN',
      },
    };
  }

  if (!accessToken) {
    throw new Error('Missing TIKTOK_ACCESS_TOKEN');
  }

  const json = await tiktokJson(
    accessToken,
    'POST',
    '/v2/post/publish/status/fetch/',
    { publish_id: publishId },
  );

  const status =
    json?.data?.status ||
    json?.status ||
    'UNKNOWN';

  return {
    json: {
      ...json,
      publishId,
      status,
      dryRun: false,
    },
  };
}

/** Optional: still allow calling MCP CLI when needed */
export function runPublisherCommand(tiktokProjectDir, args, { timeoutMs = 120000 } = {}) {
  const bin = path.join(tiktokProjectDir, 'node_modules', '.bin', 'tiktok-agent-publisher');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: tiktokProjectDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout.trim());
      } catch {
        /* ignore */
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Exit ${code}`));
        return;
      }
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), json });
    });
  });
}
