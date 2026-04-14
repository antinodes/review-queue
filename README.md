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

## Install as PWA

Open in Chrome or Edge and click the install icon in the address bar. The app works standalone from your dock.

## Deploy

```bash
npm run build
```

Serve the `dist/` directory from any static host (GitHub Pages, Netlify, Cloudflare Pages, etc.).

## Stack

- [Vite](https://vite.dev) + TypeScript
- GitHub REST Search API + GraphQL API
- Vanilla DOM — no framework
