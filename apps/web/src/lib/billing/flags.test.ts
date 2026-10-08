import { describe, expect, it } from 'vitest'
import { features } from '../features'
import { ordersEnabledFor } from './flags'

describe('orders flag', () => {
  it('is on in every environment as the site ships (#133)', () => {
    for (const environment of ['local', 'staging', 'production']) {
      expect(
        ordersEnabledFor({ D1_RUNTIME_ENV: environment, SITE_ENVIRONMENT: environment }),
        environment
      ).toBe(true)
    }
  })

  it('turns on with the flag off only on a local Worker that asks', () => {
    const off = { ...features, orders: false }
    const local = { D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' }
    expect(ordersEnabledFor(local, off)).toBe(false)
    expect(ordersEnabledFor({ ...local, LOCAL_ORDERS: 'on' }, off)).toBe(true)
    for (const environment of ['staging', 'production']) {
      expect(
        ordersEnabledFor(
          { D1_RUNTIME_ENV: environment, LOCAL_ORDERS: 'on', SITE_ENVIRONMENT: environment },
          off
        )
      ).toBe(false)
    }
  })
})
