import { describe, expect, it } from 'vitest'
import {
  clientIp,
  OTP_REQUEST_LIMITS,
  otpClientRules,
  otpEmailRules,
  rateLimitAddress,
  signInAttemptRules,
  UNKNOWN_IP
} from './rate-limits'

describe('client address keys', () => {
  it('keeps IPv4 addresses as they are', () => {
    expect(rateLimitAddress('198.51.100.7')).toBe('198.51.100.7')
    expect(rateLimitAddress(' 203.0.113.250 ')).toBe('203.0.113.250')
    expect(rateLimitAddress('198.51.100.7')).not.toBe(rateLimitAddress('198.51.100.8'))
  })

  it('groups every IPv6 address of one /64 into one key', () => {
    const subnet = '2001:db8:77:77::/64'
    for (const address of [
      '2001:db8:77:77::1',
      '2001:db8:77:77::10',
      '2001:DB8:0077:0077:ffff:ffff:ffff:ffff',
      '2001:db8:77:77:1:2:3:4',
      '2001:db8:77:77:a:b:1.2.3.4'
    ]) {
      expect(rateLimitAddress(address), address).toBe(subnet)
    }
    expect(rateLimitAddress('2001:db8:77:78::1')).toBe('2001:db8:77:78::/64')
    expect(rateLimitAddress('::1')).toBe('0:0:0:0::/64')
    expect(rateLimitAddress('fe80::1')).toBe('fe80:0:0:0::/64')
  })

  it('reads IPv4-mapped IPv6 addresses as IPv4', () => {
    expect(rateLimitAddress('::ffff:198.51.100.7')).toBe('198.51.100.7')
    expect(rateLimitAddress('::ffff:c633:6407')).toBe('198.51.100.7')
  })

  it('puts anything that is not an IP address in the shared unknown bucket', () => {
    for (const value of [
      null,
      undefined,
      '',
      'unknown',
      '256.1.1.1',
      '1.2.3',
      '2001:db8::1::2',
      '2001:db8:1:2:3:4:5:6:7',
      'g::1',
      '198.51.100.7, 10.0.0.1'
    ]) {
      expect(rateLimitAddress(value), String(value)).toBe(UNKNOWN_IP)
    }
    expect(clientIp(new Headers())).toBe(UNKNOWN_IP)
    expect(clientIp(new Headers({ 'cf-connecting-ip': '2001:db8:1:2::99' }))).toBe(
      '2001:db8:1:2::/64'
    )
  })

  // Review round 3, finding 2: cf-connecting-ipv6 is trusted only behind a Pseudo IPv4 address.
  it('ignores a client-sent cf-connecting-ipv6 next to a real IPv4 address', () => {
    const headers = (ipv4: string, ipv6?: string) =>
      new Headers({ 'cf-connecting-ip': ipv4, ...(ipv6 ? { 'cf-connecting-ipv6': ipv6 } : {}) })
    // Eight forged IPv6 headers from one IPv4 client stay in that client's bucket.
    for (let index = 1; index <= 8; index += 1) {
      expect(clientIp(headers('198.51.100.7', `2001:db8:${index}:1::1`))).toBe('198.51.100.7')
    }
    expect(clientIp(headers('2001:db8:1:2::99', '2001:db8:ffff:1::1'))).toBe('2001:db8:1:2::/64')
    expect(clientIp(new Headers({ 'cf-connecting-ipv6': '2001:db8:9:9::3' }))).toBe(UNKNOWN_IP)
  })

  it('reads the IPv6 /64 when Pseudo IPv4 overwrote cf-connecting-ip with a Class E address', () => {
    // With "Overwrite Headers", cf-connecting-ip is a Class E (240.0.0.0/4) address hashed from
    // the full IPv6 address: one bucket per address unless the real IPv6 header is read.
    const pseudo = (ipv4: string, ipv6?: string) =>
      clientIp(
        new Headers({ 'cf-connecting-ip': ipv4, ...(ipv6 ? { 'cf-connecting-ipv6': ipv6 } : {}) })
      )
    expect(pseudo('240.16.0.1', '2001:db8:9:9::1')).toBe('2001:db8:9:9::/64')
    expect(pseudo('255.1.2.3', '2001:db8:9:9::2')).toBe('2001:db8:9:9::/64')
    // Without a usable IPv6 address the Class E address is still the client.
    expect(pseudo('240.16.0.2')).toBe('240.16.0.2')
    expect(pseudo('240.16.0.3', 'not-an-address')).toBe('240.16.0.3')
    expect(pseudo('240.16.0.4', '198.51.100.7')).toBe('240.16.0.4')
    // 239.x is not Class E.
    expect(pseudo('239.255.255.255', '2001:db8:9:9::1')).toBe('239.255.255.255')
  })
})

describe('sign-in code rules', () => {
  const scopes = (rules: ReturnType<typeof otpEmailRules>) =>
    rules.map(rule => `${rule.scope}:${rule.key}:${rule.max}/${rule.windowMs}`)
  const site = `otp-site:all:${OTP_REQUEST_LIMITS.siteHourly.max}/3600000`

  it('limits every client the same way, whatever the email', () => {
    expect(scopes(otpClientRules('198.51.100.7'))).toEqual([
      'otp-ip:198.51.100.7:5/60000',
      'otp-ip:198.51.100.7:20/3600000'
    ])
  })

  it('limits a new email as one budget and the whole site', () => {
    const rules = otpEmailRules({ email: 'a@example.com', ip: '198.51.100.7', standing: 'new' })
    expect(scopes(rules)).toEqual([
      'otp-email:a@example.com:1/60000',
      'otp-email:a@example.com:5/3600000',
      site
    ])
  })

  it('keys a member email per client under an inbox ceiling, never the site ceiling', () => {
    const rules = otpEmailRules({
      email: 'devin@serp.co',
      ip: '198.51.100.7',
      standing: 'member'
    })
    expect(scopes(rules)).toEqual([
      'otp-email-client:devin@serp.co\u0000198.51.100.7:1/60000',
      'otp-email-client:devin@serp.co\u0000198.51.100.7:5/3600000',
      'otp-email:devin@serp.co:20/3600000'
    ])
  })

  // Review round 3, finding 4: a stolen known-device cookie cannot remove the inbox cap.
  it('gives known devices their own inbox ceiling, which other clients cannot spend', () => {
    const rules = otpEmailRules({
      email: 'devin@serp.co',
      ip: '198.51.100.7',
      standing: 'known-device'
    })
    expect(scopes(rules)).toEqual([
      'otp-email-client:devin@serp.co\u0000198.51.100.7:1/60000',
      'otp-email-client:devin@serp.co\u0000198.51.100.7:5/3600000',
      'otp-email-known-device:devin@serp.co:10/3600000'
    ])
    expect(rules.some(rule => rule.scope === 'otp-email' || rule.scope === 'otp-site')).toBe(false)
  })

  it('limits code guesses per client address', () => {
    expect(signInAttemptRules('2001:db8:1:2::/64').map(rule => rule.key)).toEqual([
      '2001:db8:1:2::/64',
      '2001:db8:1:2::/64'
    ])
  })
})
