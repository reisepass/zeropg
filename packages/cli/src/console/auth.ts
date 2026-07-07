// Pluggable auth for the console's two trust modes (docs/EDITOR-AUTH-SECURITY.md):
//
//   none   - loopback trust: the machine boundary IS the auth. Used by the
//            default `zeropg console` (binds 127.0.0.1, refuses to widen).
//   bearer - one shared token: first hop presents ?t=<token>, gets a 302 that
//            sets the zpt cookie (HttpOnly/Secure/SameSite=Lax) and strips the
//            token from the URL; every later request must carry the cookie or
//            it is a 403. Used by `zeropg console --inspector` (binds 0.0.0.0
//            behind Cloud Run). Adminer's login() re-checks the same token
//            from the cookie - a second, independent gate.
//
// A third mode is anticipated but deliberately not built: per-link HMAC of
// {target, exp} - target-scoped, expiring links minted by the fleet CLI. The
// gate() contract already gives a mode the full URL (so it can parse a target
// out of /open/<name>) and the response (so it can 403 with its own message);
// adding it is a new ConsoleAuth impl, not a caller change.

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface ConsoleAuth {
  readonly mode: 'none' | 'bearer'
  /**
   * Gate one request. Returns true when the request may proceed to routing;
   * false when the auth layer already wrote the response (403, or the 302
   * that turns ?t= into the zpt cookie).
   */
  gate(req: IncomingMessage, res: ServerResponse, url: URL): boolean
}

/** Loopback trust: every request passes. Pair ONLY with a 127.0.0.1 bind. */
export function authNone(): ConsoleAuth {
  return { mode: 'none', gate: () => true }
}

function parseCookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (header || '')
      .split(';')
      .map((c) => c.trim().split('=').map(decodeURIComponent))
      .filter((p) => p.length === 2),
  )
}

/** One shared bearer token: ?t=<token> once -> zpt cookie -> checked forever. */
export function authBearer(token: string): ConsoleAuth {
  if (!token) throw new Error('bearer auth needs a non-empty token')
  return {
    mode: 'bearer',
    gate(req, res, url) {
      // token gate: accept ?t= once, then ride the cookie (shared with Adminer)
      const cookies = parseCookies(req.headers.cookie)
      const presented = url.searchParams.get('t') || cookies.zpt || ''
      if (presented !== token) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('missing or wrong token - open the link your fleet console gave you (…?t=<token>)')
        return false
      }
      if (url.searchParams.get('t')) {
        // normalize: set the cookie, drop the token from the URL
        url.searchParams.delete('t')
        res.writeHead(302, {
          'set-cookie': `zpt=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          location: url.pathname + (url.searchParams.size ? '?' + url.searchParams : ''),
        })
        res.end()
        return false
      }
      return true
    },
  }
}
