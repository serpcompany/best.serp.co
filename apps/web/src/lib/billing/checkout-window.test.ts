import { describe, expect, it } from 'vitest'
import { SHORTEST_CHECKOUT_MS, tooLateForCheckout } from './checkout-window'

describe('checkout window (#128)', () => {
  const closesBy = Date.parse('2026-10-07T11:05:00.000Z')

  it('is the provider’s 30-minute shortest checkout with a minute’s margin', () => {
    expect(SHORTEST_CHECKOUT_MS).toBe(31 * 60 * 1000)
  })

  it('opens a checkout with the shortest checkout or more left, and none with less', () => {
    expect(tooLateForCheckout(closesBy, closesBy - SHORTEST_CHECKOUT_MS - 1000)).toBe(false)
    expect(tooLateForCheckout(closesBy, closesBy - SHORTEST_CHECKOUT_MS)).toBe(false)
    expect(tooLateForCheckout(closesBy, closesBy - SHORTEST_CHECKOUT_MS + 1000)).toBe(true)
    expect(tooLateForCheckout(closesBy, closesBy)).toBe(true)
    expect(tooLateForCheckout(closesBy, closesBy + 1000)).toBe(true)
  })
})
