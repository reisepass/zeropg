// Admin auth for the studio BFF: bcrypt password check, HMAC-signed session
// cookies, session-bound CSRF tokens, and in-memory login rate limiting.
//
// No database is involved - this is a single-admin console. The admin password
// is supplied as either a plaintext value (STUDIO_ADMIN_PASSWORD, hashed at
// boot) or a precomputed bcrypt hash (STUDIO_ADMIN_PASSWORD_HASH). Sessions are
// stateless: the cookie carries a signed payload and is verified by recomputing
// the HMAC, so no server-side session store is needed.

import bcryptjs from 'bcryptjs'
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

const bcrypt = bcryptjs.default || bcryptjs

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const fromB64url = (s) => Buffer.from(s, 'base64url')

// Constant-time string compare that never throws on length mismatch.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) {
    // still burn a compare to reduce timing signal, then return false
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

export function createAuth({
  sessionSecret,
  adminPasswordHash,
  cookieName = 'studio_session',
  sessionTtlSecs = 12 * 3600,
  loginWindowMs = 5 * 60_000,
  perIpMaxFails = 5,
  globalMaxFails = 50,
}) {
  if (!sessionSecret || sessionSecret.length < 16) {
    throw new Error('STUDIO_SESSION_SECRET must be set (>= 16 chars)')
  }
  if (!adminPasswordHash) {
    throw new Error('admin password hash is required (STUDIO_ADMIN_PASSWORD or STUDIO_ADMIN_PASSWORD_HASH)')
  }

  // --- login rate limiting (in-memory) ---
  const ipFails = new Map() // ip -> { count, resetAt }
  let globalFails = { count: 0, resetAt: Date.now() + loginWindowMs }

  function pruneGlobal() {
    if (Date.now() > globalFails.resetAt) globalFails = { count: 0, resetAt: Date.now() + loginWindowMs }
  }
  function ipEntry(ip) {
    const now = Date.now()
    let e = ipFails.get(ip)
    if (!e || now > e.resetAt) {
      e = { count: 0, resetAt: now + loginWindowMs }
      ipFails.set(ip, e)
    }
    return e
  }
  // Returns { limited, retryAfterSecs } WITHOUT counting a failure.
  function isRateLimited(ip) {
    pruneGlobal()
    const e = ipEntry(ip)
    if (e.count >= perIpMaxFails) return { limited: true, retryAfterSecs: Math.ceil((e.resetAt - Date.now()) / 1000) }
    if (globalFails.count >= globalMaxFails) return { limited: true, retryAfterSecs: Math.ceil((globalFails.resetAt - Date.now()) / 1000) }
    return { limited: false }
  }
  function recordFail(ip) {
    pruneGlobal()
    ipEntry(ip).count += 1
    globalFails.count += 1
  }
  function recordSuccess(ip) {
    ipFails.delete(ip)
  }

  // --- password check ---
  async function verifyPassword(password) {
    if (typeof password !== 'string' || password.length === 0) return false
    try {
      return await bcrypt.compare(password, adminPasswordHash)
    } catch {
      return false
    }
  }

  // --- session token (signed, stateless) ---
  // token = <payloadB64url>.<sigB64url>, payload = { sub, iat, exp, nonce }
  function sign(payloadB64) {
    return createHmac('sha256', sessionSecret).update(payloadB64).digest('base64url')
  }
  function issueSession(sub = 'admin') {
    const now = Math.floor(Date.now() / 1000)
    const payload = { sub, iat: now, exp: now + sessionTtlSecs, nonce: b64url(randomBytes(9)) }
    const payloadB64 = b64url(JSON.stringify(payload))
    return `${payloadB64}.${sign(payloadB64)}`
  }
  function verifySession(token) {
    if (typeof token !== 'string') return null
    const parts = token.split('.')
    if (parts.length !== 2) return null // canonical: exactly <payload>.<sig>, no trailing junk
    const [payloadB64, sig] = parts
    if (!payloadB64 || !sig) return null
    if (!safeEqual(sig, sign(payloadB64))) return null
    let payload
    try { payload = JSON.parse(fromB64url(payloadB64).toString('utf8')) } catch { return null }
    if (!payload || typeof payload.exp !== 'number') return null
    if (Math.floor(Date.now() / 1000) >= payload.exp) return null
    return payload
  }

  // --- CSRF token, bound to the session token (double-submit, HMAC-derived) ---
  function csrfFor(sessionToken) {
    return createHmac('sha256', `csrf:${sessionSecret}`).update(String(sessionToken)).digest('base64url')
  }
  function csrfValid(sessionToken, provided) {
    if (!sessionToken || !provided) return false
    return safeEqual(provided, csrfFor(sessionToken))
  }

  // --- cookie helpers ---
  function cookieHeader(token, { secure }) {
    const parts = [
      `${cookieName}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${sessionTtlSecs}`,
    ]
    if (secure) parts.push('Secure')
    return parts.join('; ')
  }
  function clearCookieHeader({ secure }) {
    const parts = [`${cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
    if (secure) parts.push('Secure')
    return parts.join('; ')
  }
  function readCookie(req) {
    const raw = req.headers.cookie
    if (!raw) return null
    for (const pair of raw.split(';')) {
      const idx = pair.indexOf('=')
      if (idx === -1) continue
      const k = pair.slice(0, idx).trim()
      if (k === cookieName) return pair.slice(idx + 1).trim()
    }
    return null
  }

  return {
    cookieName,
    verifyPassword,
    issueSession,
    verifySession,
    csrfFor,
    csrfValid,
    cookieHeader,
    clearCookieHeader,
    readCookie,
    isRateLimited,
    recordFail,
    recordSuccess,
  }
}

// Hash a plaintext password (used at boot when only STUDIO_ADMIN_PASSWORD is set,
// and by the CLI hash helper).
export async function hashPassword(plain, rounds = 10) {
  return bcrypt.hash(plain, rounds)
}
