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
    const updated = params.get('updated') || '0';
    const unchanged = params.get('unchanged') || '0';
    const scope = params.get('scope') || '';
    const hasPublish =
      params.get('has_publish') === '1' || params.get('has_upload') === '1';
    if (!hasPublish) {
      showAuthMsg(
        `Signed in, but this authorization is missing video.upload / video.publish (granted: ${scope || 'none'}). ` +
          `Enable Content Posting API in the developer console, then authorize again.`,
        false,
      );
    } else {
      showAuthMsg(
        `Signed in. Token synced (updated ${updated} file(s)). Granted scopes: ${scope}`,
        true,
      );
    }
  } else if (auth === 'error') {
    showAuthMsg(params.get('message') || 'Authorization failed.', false);
  }

  window.history.replaceState({}, '', '/');
}

const scopeHint = document.getElementById('scope-hint');

async function refreshStatus() {
  authBadge.textContent = 'Checking…';
  authBadge.className = 'badge muted';

  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Status check failed');

    scopeHint.textContent = `Requested scopes: ${(data.requested_scopes || []).join(', ')} · post_mode: ${data.post_mode || '-'}`;

    if (data.logged_in) {
      authBadge.textContent = 'Logged in';
      authBadge.className = 'badge';
      publishPanel.hidden = false;
      dryRunBadge.textContent = data.dry_run
        ? 'Dry-run ON (safe test mode)'
        : 'Live publish enabled';
      dryRunBadge.className = data.dry_run ? 'badge warn' : 'badge';
    } else {
      authBadge.textContent = 'Not logged in';
      authBadge.className = 'badge warn';
      publishPanel.hidden = true;
    }
  } catch (err) {
    authBadge.textContent = 'Error';
    authBadge.className = 'badge err';
    showAuthMsg(String(err.message || err), false);
  }
}

async function checkPublishPermission() {
  showAuthMsg('Checking Content Posting permission…', true);
  try {
    const res = await fetch('/api/token-check');
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

document.getElementById('refresh-status').addEventListener('click', refreshStatus);
document.getElementById('token-check').addEventListener('click', checkPublishPermission);

handleAuthQuery();
refreshStatus();
