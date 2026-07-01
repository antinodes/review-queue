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
  secret and can't run in the browser). The AWS CDK stack in [`infra/`](infra/) provisions
  it — S3 + CloudFront + a token-exchange Lambda.

Config is via Vite env vars (see [`.env.example`](.env.example)):

| Var | Effect |
|-----|--------|
| `VITE_GITHUB_CLIENT_ID` | OAuth App client id. Set with `VITE_TOKEN_EXCHANGE_URL` to enable OAuth. |
| `VITE_TOKEN_EXCHANGE_URL` | Exchange endpoint (`/auth/exchange` on the CDK stack). |
| `VITE_GITHUB_SCOPE` | OAuth scope, defaults to `repo`. |
| `VITE_ENABLE_PAT` | `"true"` keeps the PAT form visible alongside OAuth. |

With no OAuth vars set the app shows the PAT form; with them set it shows OAuth only
(unless `VITE_ENABLE_PAT=true`), so it's never unusable.

## Install as PWA

Open in Chrome or Edge and click the install icon in the address bar. The app works standalone from your dock.

## Deploy

```bash
npm run build
```

Serve the `dist/` directory from any static host (GitHub Pages, Netlify, Cloudflare Pages, etc.)
for PAT-based auth.

For **OAuth on AWS**, deploy the CDK stack in [`infra/`](infra/) — it builds and hosts the app
on S3 + CloudFront and wires up the token-exchange Lambda. See [`infra/README.md`](infra/README.md).

## Stack

- [Vite](https://vite.dev) + TypeScript
- GitHub REST Search API + GraphQL API
- Vanilla DOM — no framework
