# Review Queue

A lightweight PWA that shows GitHub PRs awaiting your review, split into two buckets:

- **Ready for Review** — CI passing, no unresolved review threads
- **Blocked by Comments** — CI passing, but has unresolved threads

PRs that are in draft, have failing CI, or pending checks are excluded from both lists.

## Features

- Grouped by repo, sorted oldest-first
- Days open excludes time spent in draft
- Auto-refreshes every 3 minutes with non-disruptive progress indicator
- App badge shows count of ready PRs when installed as a PWA
- Single GitHub API call per repo via batched GraphQL

## Setup

```bash
npm install
npm run dev
```

On first load, paste a GitHub personal access token with `repo` scope. The token is stored in `localStorage` on your device only.

## Authentication

Two ways to sign in, selected by build-time config:

- **Personal access token (default).** Zero config — paste a token with `repo` scope.
  This is what `npm run dev` and any static host use out of the box.
- **GitHub OAuth (hosted).** A "Sign in with GitHub" button, no token pasting. Requires
  a small backend to exchange the OAuth code for a token (the exchange needs the client
  secret and can't run in the browser). Any backend implementing the contract below works;
  a single serverless function is enough.

Config is via Vite env vars (see [`.env.example`](.env.example)):

| Var | Effect |
|-----|--------|
| `VITE_GITHUB_CLIENT_ID` | OAuth App client id. Set with `VITE_TOKEN_EXCHANGE_URL` to enable OAuth. |
| `VITE_TOKEN_EXCHANGE_URL` | Exchange endpoint: a same-origin path (e.g. `/auth/exchange`) or absolute URL. |
| `VITE_GITHUB_SCOPE` | OAuth scope, defaults to `repo`. |
| `VITE_ENABLE_PAT` | `"true"` keeps the PAT form visible alongside OAuth. |

With no OAuth vars set the app shows the PAT form; with them set it shows OAuth only
(unless `VITE_ENABLE_PAT=true`), so it's never unusable.

### Token-exchange endpoint contract

The app sends the exchange endpoint a `POST` with a JSON body:

```json
{ "code": "<code from GitHub's callback>", "redirect_uri": "<URL that started the flow>" }
```

The backend forwards these to `https://github.com/login/oauth/access_token` along with the
OAuth App's client id and secret, and on success responds `200` with:

```json
{ "access_token": "gho_..." }
```

On failure it responds with a non-2xx status and `{ "error", "error_description" }`; the
`error_description` is shown to the user. Serve the endpoint same-origin with the app
(e.g. routed at `/auth/exchange` behind the same CDN) so no CORS setup is needed.

## Install as PWA

Open in Chrome or Edge and click the install icon in the address bar. The app works standalone from your dock.

## Deploy

```bash
npm run build
```

Serve the `dist/` directory from any static host (GitHub Pages, Netlify, Cloudflare Pages, etc.)
for PAT-based auth. Pushes to `main` deploy to GitHub Pages automatically.

For **OAuth**, also host a token-exchange backend (see the contract above) and set
`VITE_GITHUB_CLIENT_ID` and `VITE_TOKEN_EXCHANGE_URL` at build time.

## Stack

- [Vite](https://vite.dev) + TypeScript
- GitHub REST Search API + GraphQL API
- Vanilla DOM — no framework
