/**
 * Failures whose message is fixed and holds no user input, each with a stable code for logs
 * (#211): configuration (a missing binding or secret), billing invariants (a refund with no
 * paid order), and a page's account guard that could not decide (#389). A Worker log line spreads in only `errorFields(error)`, which prefers an error's
 * own `code`, so the line names the failure without its message. A code never carries an
 * identifier: an id stays in the message, or in the log line's own fields.
 */
export const FAILURE_CODES = [
  'auth_guard_failed',
  'billing_mock_port_invalid',
  'billing_mock_port_not_local',
  'billing_secret_key_wrong_mode',
  'billing_secrets_missing',
  'billing_tax_unsupported',
  'd1_binding_missing',
  'd1_runtime_env_invalid',
  'r2_binding_missing',
  'refund_claim_failed',
  'refund_not_claimed',
  'refund_not_recorded',
  'refund_order_missing',
  'refund_paid_order_missing',
  'refund_payment_missing',
  'refund_rejection_prohibited',
  'refund_submission_not_rejected'
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

/** An error with a fixed message and its `FailureCode`. Import-free, like `error-fields.ts`. */
export class CodedError extends Error {
  readonly code: FailureCode

  constructor(code: FailureCode, message: string) {
    super(message)
    this.code = code
  }
}
