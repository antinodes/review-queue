# review-queue infrastructure (AWS CDK)

Provisions the AWS resources that let review-queue log in with **GitHub OAuth**
instead of a pasted personal access token:

```
CloudFront ── /*        ─→  S3 bucket (the built app, private + OAC)
           └─ /auth/*   ─→  Lambda Function URL (OAuth token exchange)
```

The Lambda is routed on the **same CloudFront origin** as the app, so the browser
makes a same-origin request to `/auth/exchange` — no CORS, and the frontend needs
no backend URL baked into its build. The OAuth **client secret lives only in the
Lambda's environment** and is never sent to the browser or committed.

Everything here sits in the AWS perpetual free tier for a personal-scale app (~$0).

## Prerequisites

- An AWS account and credentials (`aws configure` or SSO). Set `CDK_DEFAULT_ACCOUNT`
  and `CDK_DEFAULT_REGION`.
- Node.js 22+.
- CDK bootstrapped in the target account/region once: `npx cdk bootstrap`.

## 1. Register a GitHub OAuth App

GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App.

- **Homepage URL:** your CloudFront URL (you'll get it after the first deploy — a
  placeholder is fine now, update it after).
- **Authorization callback URL:** the CloudFront URL with a trailing slash, e.g.
  `https://d111111abcdef8.cloudfront.net/`.

Note the **Client ID**, then generate a **Client secret**.

> First deploy is a chicken-and-egg: you need the CloudFront domain for the callback,
> but the domain only exists after deploying. Deploy once with a placeholder client id
> to get the domain, register/adjust the OAuth App, then redeploy with the real values.

## 2. Build the app

From the repo root, build with the OAuth client id and the same-origin exchange path:

```bash
VITE_GITHUB_CLIENT_ID=<your-client-id> \
VITE_TOKEN_EXCHANGE_URL=/auth/exchange \
npm run build
```

This writes `dist/`, which the stack uploads to S3.

## 3. Deploy

```bash
cd infra
npm install

# The client id is public; keep the secret out of shell history / source.
GITHUB_CLIENT_ID=<your-client-id> \
GITHUB_CLIENT_SECRET=<your-client-secret> \
npx cdk deploy
```

Outputs include **SiteUrl** (the CloudFront URL). Use it as the OAuth App homepage
and callback (with trailing slash), rebuild/redeploy if the client id changed, and
you're done.

## Configuration reference

| Input | Where | Purpose |
|-------|-------|---------|
| `GITHUB_CLIENT_ID` | deploy env | Baked into the Lambda; also used in the frontend build |
| `GITHUB_CLIENT_SECRET` | deploy env | Lambda env only — never committed |
| `VITE_GITHUB_CLIENT_ID` | frontend build | Enables the OAuth flow in the app |
| `VITE_TOKEN_EXCHANGE_URL` | frontend build | `/auth/exchange` (same-origin) |

Both `GITHUB_*` vars are required — `cdk` commands fail fast at synth rather than
deploy a Lambda with empty credentials.

## Teardown

```bash
# The synth-time credential check applies to destroy too; any values work here.
cd infra && GITHUB_CLIENT_ID=x GITHUB_CLIENT_SECRET=x npx cdk destroy
```

The bucket has `autoDeleteObjects` + `DESTROY` removal policy, so it empties and
deletes with the stack.

## Notes / future hardening

- The Function URL uses `authType: NONE` and is reachable directly (not only via
  CloudFront). It only performs the OAuth code exchange, which requires a valid
  GitHub `code` issued to this OAuth App, so the exposure is low. Locking it to
  CloudFront with Origin Access Control (SigV4) is a reasonable later hardening step.
- The secret is a plaintext Lambda env var. Moving it to SSM SecureString or Secrets
  Manager is a straightforward upgrade if you want rotation.
- Uses the default `*.cloudfront.net` domain. A custom domain would add an ACM
  certificate (in `us-east-1`) and a DNS record.
