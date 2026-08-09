// GitHub OAuth token exchange. Runs server-side because the exchange needs the
// client secret and GitHub's token endpoint sends no CORS headers.
//
// Served same-origin behind CloudFront at /auth/*, so the browser never makes a
// cross-origin call. Deliberately NO CORS headers here: if the Function URL is
// hit directly from another site, the browser blocks the response.

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'

const resp = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const handler = async (event) => {
  const method = event.requestContext?.http?.method
  if (method !== 'POST') return resp(405, { error: 'method_not_allowed' })

  let code, redirect_uri
  try {
    ;({ code, redirect_uri } = JSON.parse(event.body ?? '{}'))
  } catch {
    return resp(400, { error: 'invalid_json' })
  }
  if (!code) return resp(400, { error: 'missing_code' })

  let ghRes
  try {
    ghRes = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri,
      }),
    })
  } catch {
    return resp(502, { error: 'github_unreachable', error_description: 'Could not reach GitHub — try again.' })
  }

  // GitHub can return non-JSON (HTML error pages) during outages.
  let data
  try {
    data = await ghRes.json()
  } catch {
    return resp(502, { error: 'github_error', error_description: `GitHub returned ${ghRes.status} — try again.` })
  }

  if (data.error) return resp(400, { error: data.error, error_description: data.error_description })
  if (!data.access_token) {
    return resp(502, { error: 'no_token', error_description: 'GitHub did not return a token — try again.' })
  }
  return resp(200, { access_token: data.access_token })
}
