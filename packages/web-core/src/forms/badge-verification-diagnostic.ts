import { BADGE_VERIFIER_USER_AGENT } from './submission-contract'

export type BadgeVerificationDiagnostic = {
  message: string
  title: string
}

export function getBadgeVerificationDiagnostic(
  code: string | null | undefined,
  website: string
): BadgeVerificationDiagnostic {
  if (code === 'badge_missing') {
    return {
      message: `We loaded ${website}, but the Featured on SERP Software badge was not present in the returned HTML. Publish the exact snippet on that URL, then try again.`,
      title: 'Page reached — badge not found'
    }
  }
  if (code === 'site_unreachable' || code === 'fetch_failed') {
    return {
      message: `We could not load ${website} from our verification service. Confirm the URL is public and that its firewall or bot protection allows verification requests, then try again.`,
      title: 'Website could not be reached'
    }
  }
  if (code === 'fetch_timeout') {
    return {
      message: `We could not load ${website} within 8 seconds. Check that the page responds promptly and is not delaying or blocking automated requests, then try again.`,
      title: 'Website took too long to respond'
    }
  }
  if (code === 'nofollow') {
    return {
      message:
        'We found the badge, but its link includes nofollow. Remove nofollow from the badge link, publish the change, then try again.',
      title: 'Badge found — remove nofollow'
    }
  }
  if (code === 'wrong_destination') {
    return {
      message:
        'We found the badge image, but its link does not point to the listing URL shown below. Replace it with the exact snippet, publish the change, then try again.',
      title: 'Badge found — link target is incorrect'
    }
  }
  if (code === 'not_html') {
    return {
      message: `${website} did not return an HTML web page. Enter a public page URL where the badge can appear, then start a new submission.`,
      title: 'Submitted URL did not return a web page'
    }
  }
  if (code === 'response_too_large') {
    return {
      message: `The HTML returned by ${website} exceeded the 1 MB verification limit. Reduce the initial page size or use a smaller public page URL, then try again.`,
      title: 'Page is too large to verify'
    }
  }
  if (code === 'invalid_target') {
    return {
      message:
        'The submitted URL is not a public HTTP or HTTPS address that the verifier can safely request. Start a new submission with a public website URL.',
      title: 'Submitted URL cannot be verified'
    }
  }
  if (code === 'invalid_redirect') {
    return {
      message: `${website} returned a redirect without a valid public destination. Fix the redirect configuration, then try again.`,
      title: 'Website returned an invalid redirect'
    }
  }
  if (code === 'too_many_redirects') {
    return {
      message: `${website} redirected more than three times. Shorten or fix the redirect chain, then try again.`,
      title: 'Website redirected too many times'
    }
  }
  if (code === 'verification_service_error') {
    return {
      message:
        'Our verification service encountered an unexpected problem. Your submission is still saved and this did not consume a badge-content attempt; wait a moment and try again.',
      title: 'Verification service had a problem'
    }
  }
  if (code === 'attempt_limit') {
    return {
      message:
        'Too many badge-content checks were unsuccessful. Your submission is still saved, but automatic verification is paused. Keep your private resume link and contact the SERP Software maintainer for help.',
      title: 'Verification attempt limit reached'
    }
  }
  if (code === 'cooldown') {
    return {
      message:
        'Checks are limited to one every 30 seconds. Your submission is still saved; wait a moment before trying again.',
      title: 'Please wait before checking again'
    }
  }

  const httpStatus = code?.match(/^http_(\d{3})$/)?.[1]
  if (httpStatus) {
    const status = Number(httpStatus)
    if (status === 404 || status === 410) {
      return {
        message: `${website} returned HTTP ${httpStatus}, so there was no page to scan. Publish the submitted URL or start a new submission with the correct public page.`,
        title: 'Submitted page was not found'
      }
    }
    if (status === 429) {
      return {
        message: `${website} returned HTTP 429 and temporarily rate-limited the check. Wait before trying again or allow the ${BADGE_VERIFIER_USER_AGENT} user agent.`,
        title: 'Website temporarily rate-limited verification'
      }
    }
    if (status === 530) {
      return {
        message: `The verifier received HTTP 530 before it could load a page from ${website}. Check the domain DNS, origin server, and firewall or bot-protection settings, then try again.`,
        title: 'Website could not be reached'
      }
    }
    if (status >= 500) {
      return {
        message: `${website} returned HTTP ${httpStatus}, which means its server failed before the badge could be checked. Restore the page, then try again.`,
        title: 'Website returned a server error'
      }
    }
    return {
      message: `We reached ${website}, but it refused the verification request. Make the page publicly accessible and allow the ${BADGE_VERIFIER_USER_AGENT} user agent, then try again.`,
      title: `Website returned HTTP ${httpStatus}`
    }
  }

  return {
    message:
      'The verification service could not complete this check. Your submission is still saved; wait a moment and try again.',
    title: 'Verification could not be completed'
  }
}
