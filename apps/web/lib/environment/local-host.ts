/**
 * True when a request was made to this machine: `localhost`, `127.0.0.1`, `[::1]`, or a
 * `*.localhost` name. The local-only dev endpoints (#164) check this as well as the Worker's
 * local vars, so a deploy that somehow ran with the local config still serves them to no one.
 */
export function isLocalRequestHost(requestUrl: string): boolean {
  let hostname: string
  try {
    hostname = new URL(requestUrl).hostname
  } catch {
    return false
  }
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  )
}
