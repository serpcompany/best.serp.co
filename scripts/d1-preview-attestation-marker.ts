function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

async function main(): Promise<void> {
  const [operation] = process.argv.slice(2)
  if (operation !== 'install' && operation !== 'delete' && operation !== 'assert-absent')
    throw new Error('Usage: d1-preview-attestation-marker.ts <install|delete|assert-absent>')
  if (operation === 'assert-absent') {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${required('CLOUDFLARE_ACCOUNT_ID')}/d1/database/${required('CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID')}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sql: "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='_replatform_preview_attestation'",
          params: []
        })
      }
    )
    const payload = (await response.json()) as {
      result?: Array<{ results?: Array<{ count?: number }>; success?: boolean }>
      success?: boolean
    }
    if (
      !response.ok ||
      payload.success === false ||
      payload.result?.[0]?.success === false ||
      payload.result?.[0]?.results?.[0]?.count !== 0
    )
      throw new Error('Preview attestation marker still exists.')
    return
  }
  const statements =
    operation === 'install'
      ? [
          'CREATE TABLE IF NOT EXISTS _replatform_preview_attestation (id INTEGER PRIMARY KEY CHECK(id=1), nonce TEXT NOT NULL)',
          'INSERT INTO _replatform_preview_attestation (id,nonce) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce'
        ]
      : ['DROP TABLE IF EXISTS _replatform_preview_attestation']
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${required('CLOUDFLARE_ACCOUNT_ID')}/d1/database/${required('CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID')}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        batch: statements.map((sql, index) => ({
          sql,
          params:
            operation === 'install' && index === 1
              ? [required('REPLATFORM_PREVIEW_BINDING_NONCE')]
              : []
        }))
      })
    }
  )
  const payload = (await response.json()) as {
    result?: Array<{ success?: boolean }>
    success?: boolean
  }
  if (
    !response.ok ||
    payload.success === false ||
    !payload.result ||
    payload.result.some(item => item.success === false)
  )
    throw new Error('Preview attestation marker operation failed.')
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
