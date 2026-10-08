const authBadge = document.getElementById('auth-badge');
const authMsg = document.getElementById('auth-msg');
const publishPanel = document.getElementById('publish-panel');
const dryRunBadge = document.getElementById('dry-run-badge');
const publishForm = document.getElementById('publish-form');
const submitBtn = document.getElementById('submit-btn');
const publishBox = document.getElementById('publish-box');
const publishSummary = document.getElementById('publish-summary');
const publishRaw = document.getElementById('publish-raw');
const statusSummary = document.getElementById('status-summary');
const statusRaw = document.getElementById('status-raw');
const scopeHint = document.getElementById('scope-hint');
const statusDetail = document.getElementById('status-detail');
const loginBtn = document.getElementById('login-btn');

function showAuthMsg(text, ok) {
  authMsg.hidden = false;
  authMsg.textContent = text;
  authMsg.className = `msg ${ok ? 'ok' : 'err'}`;
}

function handleAuthQuery() {
  const params = new URLSearchParams(window.location.search);
  const auth = params.get('auth');
  if (!auth) return;

  if (auth === 'success') {
    const scope = params.get('scope') || '';
    const hasPublish =
      params.get('has_publish') === '1' || params.get('has_upload') === '1';
    if (!hasPublish) {
      showAuthMsg(
        `Signed in, but this authorization is missing video.upload / video.publish (granted: ${scope || 'none'}). ` +
          `Enable Content Posting API in the Sandbox app, request only enabled scopes, then authorize again.`,
        false,
      );
    } else {
      showAuthMsg(
        `Login successful. Granted scopes: ${scope || 'unknown'}`,
        true,
      );
    }
  } else if (auth === 'error') {
    showAuthMsg(params.get('message') || 'Authorization failed.', false);
  }

  window.history.replaceState({}, '', '/');
}

async function refreshStatus() {
  authBadge.textContent = 'Checking…';
  authBadge.className = 'badge muted';
  statusDetail.textContent = '';

  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Status check failed');

    scopeHint.textContent =
      `Requested scopes: ${(data.requested_scopes || []).join(', ')} · post_mode: ${data.post_mode || '-'}` +
      ` · redirect: ${data.redirect_uri || '-'}`;

    if (data.logged_in) {
      authBadge.textContent = 'Logged in';
      authBadge.className = 'badge';
      publishPanel.hidden = false;
      dryRunBadge.textContent = data.dry_run
        ? 'Dry-run ON (safe test mode)'
        : 'Live publish enabled';
      dryRunBadge.className = data.dry_run ? 'badge warn' : 'badge';
      statusDetail.textContent = data.token_tail
        ? `Access token saved locally (ends with …${data.token_tail}). If Continue does nothing on the auth page, revoke this app in TikTok settings and try again.`
        : 'Access token saved locally.';
      if (!authMsg.hidden && authMsg.classList.contains('err')) {
        /* keep error visible */
      } else if (authMsg.hidden) {
        showAuthMsg('Status: logged in. You can upload a video or re-authorize to refresh scopes.', true);
      }
    } else {
      authBadge.textContent = 'Not logged in';
      authBadge.className = 'badge warn';
      publishPanel.hidden = true;
      statusDetail.textContent =
        'No local token found. Click Scan & authorize. If TikTok shows “additional access” with an empty permission list, revoke the app first and confirm Sandbox has video.upload enabled.';
    }
  } catch (err) {
    authBadge.textContent = 'Error';
    authBadge.className = 'badge err';
    showAuthMsg(String(err.message || err), false);
  }
}

async function startLogin() {
  showAuthMsg('Redirecting to TikTok authorization… Use one tab only; you will return here after approval.', true);
  loginBtn.disabled = true;
  try {
    const res = await fetch('/api/auth/start?json=1', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok || !data.auth_url) {
      throw new Error(data.error || 'Failed to build auth URL');
    }
    window.location.assign(data.auth_url);
  } catch (err) {
    loginBtn.disabled = false;
    showAuthMsg(String(err.message || err), false);
  }
}

async function checkPublishPermission() {
  showAuthMsg('Checking Content Posting permission…', true);
  try {
    const res = await fetch('/api/token-check', { cache: 'no-store' });
    const data = await res.json();
    if (data.can_publish) {
      showAuthMsg(data.tip || 'Upload permission OK.', true);
      authBadge.textContent = 'Can upload';
      authBadge.className = 'badge';
    } else {
      showAuthMsg(
        `${data.tip || data.error || 'Cannot upload'}` +
          (data.tiktok_error ? ` [${data.tiktok_error}]` : ''),
        false,
      );
      authBadge.textContent = 'No upload scope';
      authBadge.className = 'badge err';
    }
  } catch (err) {
    showAuthMsg(String(err.message || err), false);
  }
}

async function pollStatus(publishId, attempts = 8) {
  statusSummary.textContent = 'Checking publish status…';
  statusRaw.textContent = '';

  for (let i = 0; i < attempts; i += 1) {
    const res = await fetch(`/api/publish/status?id=${encodeURIComponent(publishId)}`);
    const data = await res.json();
    statusRaw.textContent = JSON.stringify(data, null, 2);

    if (!data.ok) {
      statusSummary.textContent = `Status check failed: ${data.error}`;
      statusSummary.style.color = 'var(--err)';
      return data;
    }

    const status = String(data.status || '').toUpperCase();
    if (
      data.success ||
      ['PUBLISH_COMPLETE', 'PUBLISHED', 'SUCCESS', 'DRY_RUN', 'FAILED', 'PUBLISH_FAILED'].includes(status)
    ) {
      const ok =
        data.success &&
        !['FAILED', 'PUBLISH_FAILED'].includes(status);
      statusSummary.textContent = ok
        ? `Publish looks successful (status: ${data.status})`
        : `Publish not successful (status: ${data.status})`;
      statusSummary.style.color = ok ? 'var(--ok)' : 'var(--err)';
      return data;
    }

    statusSummary.textContent = `Status: ${data.status} — polling (${i + 1}/${attempts})…`;
    await new Promise((r) => setTimeout(r, 2000));
  }

  statusSummary.textContent = 'Status still processing. Try refresh later.';
  statusSummary.style.color = 'var(--warn)';
  return null;
}

publishForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitBtn.disabled = true;
  publishBox.hidden = false;
  publishSummary.textContent = 'Calling Content Posting API…';
  publishSummary.style.color = '';
  publishRaw.textContent = '';
  statusSummary.textContent = '';
  statusRaw.textContent = '';

  try {
    const formData = new FormData(publishForm);
    const res = await fetch('/api/publish', { method: 'POST', body: formData });
    const data = await res.json();
    publishRaw.textContent = JSON.stringify(data, null, 2);

    if (!data.ok) {
      publishSummary.textContent = `Publish failed: ${data.error}`;
      publishSummary.style.color = 'var(--err)';
      return;
    }

    publishSummary.textContent = data.publish_id
      ? `Submitted. publish_id = ${data.publish_id}`
      : 'Submitted (no publish_id returned — see raw JSON).';
    publishSummary.style.color = 'var(--ok)';

    if (data.publish_id) {
      await pollStatus(data.publish_id);
    } else {
      statusSummary.textContent = 'Skipped status check (missing publish_id).';
    }
  } catch (err) {
    publishSummary.textContent = String(err.message || err);
    publishSummary.style.color = 'var(--err)';
  } finally {
    submitBtn.disabled = false;
  }
});

loginBtn.addEventListener('click', startLogin);
document.getElementById('refresh-status').addEventListener('click', refreshStatus);
document.getElementById('token-check').addEventListener('click', checkPublishPermission);

handleAuthQuery();
refreshStatus();
