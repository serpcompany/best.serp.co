/**
 * Neutral templates that exercise the email contract in tests. They are not product emails
 * and are never registered in `./registry.ts`.
 */
import { createEmailTemplateRegistry, defineEmailTemplate, html } from './templates'

export interface FixtureInput {
  /** Root-relative path the fixture links to. */
  path: string
  title: string
}

export const fixtureTemplate = defineEmailTemplate<FixtureInput>({
  id: 'test-fixture',
  render(input, { dashboardUrl, links }) {
    const url = links.url(input.path)
    return {
      html: html`<p>${input.title}</p><p><a href="${url}">${url}</a></p><p><a href="${dashboardUrl}">${dashboardUrl}</a></p>`,
      subject: `Fixture: ${input.title}`,
      text: `${input.title}\n\n${url}\n\n${dashboardUrl}`
    }
  }
})

/** A second template, so tests can send two emails for one event. */
export const fixtureNoticeTemplate = defineEmailTemplate<FixtureInput>({
  id: 'test-fixture-notice',
  render(input, { dashboardUrl, links }) {
    const url = links.url(input.path)
    return {
      html: html`<p><a href="${url}">${input.title}</a></p><p><a href="${dashboardUrl}">x</a></p>`,
      subject: `Notice: ${input.title}`,
      text: `${input.title}: ${url} ${dashboardUrl}`
    }
  }
})

export const fixtureTemplates = createEmailTemplateRegistry({
  'test-fixture': fixtureTemplate,
  'test-fixture-notice': fixtureNoticeTemplate
})
