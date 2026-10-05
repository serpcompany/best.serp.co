import { createEmailTemplateRegistry } from './templates'

/**
 * Every email best.serp.co sends, keyed by template id. It stays empty until the templates
 * approved in serpcompany/best.serp.co#70 land (sign-in code, submission received, changes
 * requested, approved, rejected, badge missing, unlisted, claim verification code, and the
 * admin review notice); until then `enqueueEmail` accepts no template.
 */
export const appEmailTemplates = createEmailTemplateRegistry({})

export type AppEmailTemplates = typeof appEmailTemplates
