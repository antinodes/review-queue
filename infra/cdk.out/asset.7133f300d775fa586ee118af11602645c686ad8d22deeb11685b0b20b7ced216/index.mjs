// GitHub OAuth token exchange. Runs server-side because the exchange needs the
// client secret and GitHub's token endpoint sends no CORS headers.
//
// Served same-origin behind CloudFront at /auth/* (so the browser never makes a
// cross-origin call), but the CORS headers below also keep it safe if the
// Function URL is ever hit directly.

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'

const cors = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN ?? '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const resp = (statusCode, body) => ({
  statusCode,
  headers: { ...cors, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const handler = async (event) => {
  const method = event.requestContext?.http?.method
  if (method === 'OPTIONS') return { statusCode: 204, headers: cors }
  if (method !== 'POST') return resp(405, { error: 'method_not_allowed' })

  let code, redirect_uri
  try {
    ;({ code, redirect_uri } = JSON.parse(event.body ?? '{}'))
  } catch {
    return resp(400, { error: 'invalid_json' })
  }
  if (!code) return resp(400, { error: 'missing_code' })

  const ghRes = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri,
    }),
  })

  const data = await ghRes.json()
  if (data.error) return resp(400, { error: data.error, error_description: data.error_description })
  return resp(200, { access_token: data.access_token })
}
