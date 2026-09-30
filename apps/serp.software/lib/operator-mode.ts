export function isOperatorUiEnabled(): boolean {
  return process.env.ENABLE_OPERATOR_UI === 'true'
}
