/**
 * A neutral template that exercises the email contract in tests. It is not a product email
 * and is never registered in `./registry.ts`.
 */
import { createEmailTemplateRegistry, defineEmailTemplate, html } from './templates'

export interface FixtureInput {
  /** Root-relative path the fixture links to. */
  path: string
  title: string
}

export const fixtureTemplate = defineEmailTemplate<FixtureInput>({
  id: 'test-fixture',
  render(input, { links, supportAddress }) {
    const url = links.url(input.path)
    return {
      html: html`<p>${input.title}</p><p><a href="${url}">${url}</a></p><p>${supportAddress}</p>`,
      subject: `Fixture: ${input.title}`,
      text: `${input.title}\n\n${url}\n\n${supportAddress}`
    }
  }
})

export const fixtureTemplates = createEmailTemplateRegistry({ 'test-fixture': fixtureTemplate })
