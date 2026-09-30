export function isStaticExportBuild(): boolean {
  return process.env.STATIC_EXPORT === 'true'
}
