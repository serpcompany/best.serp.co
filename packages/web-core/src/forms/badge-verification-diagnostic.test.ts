import { describe, expect, it } from 'vitest'
import { getBadgeVerificationDiagnostic } from './badge-verification-diagnostic'

const WEBSITE = 'https://example.com/'

describe('badge verification diagnostics', () => {
  it('distinguishes a fetched page with no badge from an unreachable website', () => {
    expect(getBadgeVerificationDiagnostic('badge_missing', WEBSITE)).toEqual({
      message:
        'We loaded https://example.com/, but the Featured on SERP Software badge was not present in the returned HTML. Publish the exact snippet on that URL, then try again.',
      title: 'Page reached — badge not found'
    })
    expect(getBadgeVerificationDiagnostic('site_unreachable', WEBSITE)).toEqual({
      message:
        'We could not load https://example.com/ from our verification service. Confirm the URL is public and that its firewall or bot protection allows verification requests, then try again.',
      title: 'Website could not be reached'
    })
    expect(getBadgeVerificationDiagnostic('fetch_failed', WEBSITE)).toEqual(
      getBadgeVerificationDiagnostic('site_unreachable', WEBSITE)
    )
  })

  it('gives specific remediation for HTTP response classes', () => {
    expect(getBadgeVerificationDiagnostic('http_403', WEBSITE)).toEqual({
      message:
        'We reached https://example.com/, but it refused the verification request. Make the page publicly accessible and allow the SERPSoftwareBadgeVerifier/1.0 user agent, then try again.',
      title: 'Website returned HTTP 403'
    })
    expect(getBadgeVerificationDiagnostic('http_404', WEBSITE).title).toBe(
      'Submitted page was not found'
    )
    expect(getBadgeVerificationDiagnostic('http_429', WEBSITE).title).toBe(
      'Website temporarily rate-limited verification'
    )
    expect(getBadgeVerificationDiagnostic('http_503', WEBSITE).title).toBe(
      'Website returned a server error'
    )
    expect(getBadgeVerificationDiagnostic('http_530', WEBSITE)).toEqual({
      message:
        'The verifier received HTTP 530 before it could load a page from https://example.com/. Check the domain DNS, origin server, and firewall or bot-protection settings, then try again.',
      title: 'Website could not be reached'
    })
  })

  it('maps every stable verifier code without displaying raw snake-case values', () => {
    const diagnosticTitles = {
      attempt_limit: 'Verification attempt limit reached',
      fetch_timeout: 'Website took too long to respond',
      invalid_redirect: 'Website returned an invalid redirect',
      invalid_target: 'Submitted URL cannot be verified',
      nofollow: 'Badge found — remove nofollow',
      not_html: 'Submitted URL did not return a web page',
      response_too_large: 'Page is too large to verify',
      too_many_redirects: 'Website redirected too many times',
      verification_service_error: 'Verification service had a problem',
      wrong_destination: 'Badge found — link target is incorrect'
    } as const

    for (const [code, title] of Object.entries(diagnosticTitles)) {
      const diagnostic = getBadgeVerificationDiagnostic(code, WEBSITE)
      expect(diagnostic.title).toBe(title)
      if (code.includes('_')) expect(diagnostic.message).not.toContain(code)
      expect(diagnostic.message.length).toBeGreaterThan(30)
    }
  })
})
