// Turns raw MCP connection errors (from opencode or from our own client) into
// an explanation plus a concrete fix. Shared by the MCP page, the server
// detail modal and the server-side test endpoint.

export interface McpErrorHint {
  /** one-line explanation */
  title: string
  /** what to do about it */
  fix: string
  /** a fix the server editor can apply with one click */
  action?: 'use-token' | 'check-url' | 'sign-in' | 'raise-timeout' | 'check-command'
}

export function mcpErrorHint(error?: string, status?: string): McpErrorHint | undefined {
  const e = (error || '').toLowerCase()
  if (!e && status !== 'needs_auth' && status !== 'needs_client_registration') return undefined

  if (/dynamic client registration|client registration|incompatible auth server/.test(e) || status === 'needs_client_registration') {
    return {
      title: 'The server wants OAuth, but opencode cannot register itself with it',
      fix: 'Servers like Home Assistant only accept a pre-made token. Create a long-lived access token, '
        + 'send it as an "Authorization: Bearer <token>" header and turn OAuth off for this server.',
      action: 'use-token'
    }
  }
  if (status === 'needs_auth') {
    return {
      title: 'This server needs you to sign in',
      fix: 'Use Sign in to go through its OAuth consent screen, or send a token header and turn OAuth off.',
      action: 'sign-in'
    }
  }
  if (/\b401\b|unauthori[sz]ed/.test(e)) {
    return {
      title: 'Authentication was rejected',
      fix: 'The token or header is missing, wrong or expired. Edit the server and update its Authorization header.',
      action: 'use-token'
    }
  }
  if (/\b403\b|forbidden/.test(e)) {
    return {
      title: 'The server refused access',
      fix: 'The credentials are valid but lack permission, or the server only allows some clients or IP addresses.',
      action: 'use-token'
    }
  }
  // opencode tries Streamable HTTP, then falls back to legacy SSE and only
  // reports the fallback's error: a 405 there usually hides a rejected token
  if (/sse error.*\b(400|404|405)\b/.test(e)) {
    return {
      title: 'Both transports failed: opencode only reports the legacy SSE fallback',
      fix: 'The first (Streamable HTTP) attempt was refused, most often because the token is missing or wrong. '
        + 'Run the test to see the real answer, then fix the Authorization header or the URL path.',
      action: 'use-token'
    }
  }
  if (/\b404\b|\b405\b|not found|method not allowed/.test(e)) {
    return {
      title: 'The URL answered, but not as an MCP server',
      fix: 'Check the path: Streamable HTTP servers usually live at …/mcp, legacy ones at …/sse.',
      action: 'check-url'
    }
  }
  if (/enoent|no such file or directory|not found in path|command not found/.test(e)) {
    return {
      title: 'opencode could not start the command',
      fix: 'The command is not installed on the opencode host, or the project directory does not exist there.',
      action: 'check-command'
    }
  }
  if (/connection closed|exited|spawn failed/.test(e)) {
    return {
      title: 'The process stopped during startup',
      fix: 'Check the command, the package name and any environment variables it needs.',
      action: 'check-command'
    }
  }
  if (/timed? ?out|timeout|aborted/.test(e)) {
    return {
      title: 'No answer in time',
      fix: 'The server is slow, down, or unreachable from the opencode host. First runs of npx/uvx packages download for a while: raise the timeout.',
      action: 'raise-timeout'
    }
  }
  if (/econnrefused|enotfound|eai_again|fetch failed|getaddrinfo|network|unreachable|certificate|ssl|tls/.test(e)) {
    return {
      title: 'The server could not be reached',
      fix: 'Check the host name and port, and that the opencode host can resolve and reach it (Docker networks, firewalls, TLS certificates).',
      action: 'check-url'
    }
  }
  return undefined
}
