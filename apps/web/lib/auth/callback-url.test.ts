import { describe, expect, it } from 'vitest'
import { callbackDestination, DEFAULT_CALLBACK_PATH, safeCallbackPath } from './callback-url'

describe('the sign-in callback', () => {
  it('keeps paths on this site, with their query and fragment', () => {
    expect(safeCallbackPath('/submit/')).toBe('/submit/')
    expect(safeCallbackPath('/products/autoenhance.ai/?ref=x#faq')).toBe(
      '/products/autoenhance.ai/?ref=x#faq'
    )
    expect(safeCallbackPath(['/account/', '/submit/'])).toBe('/account/')
  })

  it('never redirects off-site or back to /login', () => {
    for (const value of [
      undefined,
      null,
      '',
      'https://evil.example/',
      '//evil.example/',
      '/\\evil.example/',
      '\\\\evil.example',
      'javascript:alert(1)',
      '/\nevil',
      '/login/',
      '/login',
      '/LOGIN/?callbackUrl=/submit/'
    ]) {
      expect(safeCallbackPath(value), String(value)).toBe(DEFAULT_CALLBACK_PATH)
    }
  })

  it('names the destination on the signed-in screen', () => {
    expect(callbackDestination('/submit/')).toEqual({
      button: 'Continue to Submit',
      sentence: 'Taking you back to Submit.'
    })
    expect(callbackDestination('/account/').button).toBe('Continue to your account')
    expect(callbackDestination('/products/x/').button).toBe('Continue')
  })
})
