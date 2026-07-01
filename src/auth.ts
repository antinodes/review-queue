// GitHub OAuth 2.0 web application flow.
//
// The browser redirects to GitHub, GitHub redirects back with a `code`, and we
// POST that code to a small backend (Lambda) that holds the client secret and
// returns a normal GitHub access token. That token is identical in shape to the
// PAT the app used before, so the rest of the pipeline is untouched.

const CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined
const EXCHANGE_URL = import.meta.env.VITE_TOKEN_EXCHANGE_URL as string | undefined
const SCOPE = (import.meta.env.VITE_GITHUB_SCOPE as string | undefined) ?? 'repo'

// OAuth is available only when both the client id and the exchange endpoint are
// configured at build time. Otherwise the app falls back to the PAT form.
export const oauthEnabled = Boolean(CLIENT_ID && EXCHANGE_URL)
export const patEnabled = import.meta.env.VITE_ENABLE_PAT === 'true' || !oauthEnabled

const STATE_KEY = 'review-queue-oauth-state'
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'

// Must match the callback registered on the OAuth App. BASE_URL is the deploy base.
const redirectUri = () => window.location.origin + import.meta.env.BASE_URL

function randomState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function beginOAuth(): void {
  const state = randomState()
  sessionStorage.setItem(STATE_KEY, state)
  const params = new URLSearchParams({
    client_id: CLIENT_ID!,
    redirect_uri: redirectUri(),
    scope: SCOPE,
    state,
  })
  window.location.assign(`${AUTHORIZE_URL}?${params}`)
}

// Returns a token when this page load is an OAuth callback, else null.
// Throws on CSRF (state mismatch) or exchange failure.
export async function handleOAuthCallback(): Promise<string | null> {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) return null

  const expected = sessionStorage.getItem(STATE_KEY)
  sessionStorage.removeItem(STATE_KEY)
  cleanUrl()
  if (!expected || state !== expected) throw new Error('Sign-in state mismatch — please retry.')
  return exchangeCode(code)
}

async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(EXCHANGE_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: redirectUri() }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || `Token exchange failed (${res.status})`)
  }
  return data.access_token as string
}

// Strip ?code&state so a refresh doesn't try to re-exchange a used code.
function cleanUrl(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete('code')
  url.searchParams.delete('state')
  window.history.replaceState({}, '', url.toString())
}
