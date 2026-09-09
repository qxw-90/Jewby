# Jewby

Desktop tool that helps creators share thoughtfully designed product videos—especially everyday items inspired by traditional Chinese culture, such as Chinese-style phone cases and Zhuang brocade pet accessories—then review upload results.

Brand name for developer portal / website / legal pages: **Jewby** (do not use TikTok in the app name or public URL path).

## Local app (this folder)

```bash
cd /Users/xiehaoying/project/GSByTikTok
npm install
npm start
```

Open **http://localhost:8787**

### Flow

1. Click **Scan & authorize** → official Login Kit (QR / password)
2. OAuth callback exchanges `code` for `access_token` + `refresh_token`
3. Tokens are compared with `../TikTok/.env` and `../TikTok1/.env`; only **changed** values are written
4. Return to the home page → choose a local video → upload
5. Upload uses Content Posting API (`video.upload` / local FILE_UPLOAD path)
6. Status check shows success/failure

### Prerequisites

- Fill `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` in `../TikTok/.env` (and TikTok1)
- Developer Portal redirect URI must match: `http://localhost:8787/callback`
- Install publisher deps once: `cd ../TikTok && npm install`
- Default scopes: `user.info.basic,video.upload` (set `TIKTOK_SCOPES` in `.env`)
- Default `TIKTOK_DRY_RUN=true` is safe (no live post)

## Legal pages (GitHub Pages)

Rename the GitHub repository to **`jewby`** (URL path must not contain “TikTok”), enable Pages from `/docs`, then use:

- Home: https://qxw-90.github.io/jewby/
- Terms of Service: https://qxw-90.github.io/jewby/terms.html
- Privacy Policy: https://qxw-90.github.io/jewby/privacy.html

Source files live in the [`docs/`](./docs/) folder.

In the developer portal, set **App name** to `Jewby` and point Website / Terms / Privacy to the URLs above. Contact email on the public pages: `jewby.support@gmail.com`.
