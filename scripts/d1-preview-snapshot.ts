import {
  captureApplicationSnapshot,
  emptyApplicationSnapshot,
  type SnapshotTransport,
  type SqlStatement,
  snapshotSummary
} from './d1-application-snapshot'
import { applicationTableNames } from './d1-replatform-inventory'

interface D1Result {
  results?: Array<Record<string, unknown>>
  success?: boolean
}
export interface ApplicationSnapshot {
  checksum: string
  migrationNames: unknown[]
  tables: Record<string, { checksum: string; count: number }>
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}
async function query(databaseId: string, statement: SqlStatement): Promise<D1Result> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${required('CLOUDFLARE_ACCOUNT_ID')}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(statement)
    }
  )
  const payload = (await response.json()) as { result?: D1Result[]; success?: boolean }
  if (
    !response.ok ||
    payload.success === false ||
    !payload.result ||
    payload.result.some(item => item.success === false)
  )
    throw new Error('Read-only D1 snapshot failed.')
  return payload.result[0] ?? { results: [], success: true }
}

export async function readRemoteApplicationSnapshot(
  databaseId: string
): Promise<ApplicationSnapshot> {
  const transport: SnapshotTransport = {
    async query(statement) {
      return (await query(databaseId, statement)).results ?? []
    }
  }
  const inventory = await transport.query({
    sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    params: []
  })
  const names = inventory.map(row => String(row.name))
  const present = applicationTableNames.filter(table => names.includes(table))
  if (present.length !== 0 && present.length !== applicationTableNames.length) {
    throw new Error('D1 application table inventory is partial.')
  }
  if (present.length === 0) {
    const empty = emptyApplicationSnapshot()
    return { checksum: empty.checksum, migrationNames: [], tables: snapshotSummary(empty) }
  }
  const snapshot = await captureApplicationSnapshot(transport)
  const ledgerPresent = names.includes('d1_migrations')
  const migrationNames = ledgerPresent
    ? (
        await transport.query({ sql: 'SELECT name FROM d1_migrations ORDER BY name', params: [] })
      ).map(row => row.name)
    : []
  return {
    checksum: snapshot.checksum,
    tables: snapshotSummary(snapshot),
    migrationNames
  }
}
