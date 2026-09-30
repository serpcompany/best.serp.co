import type { WebsiteMetadata } from '../content-query'

type PublishedDateSource = Pick<WebsiteMetadata, 'publishedAt'>

type CollectionPageSchemaDates = {
  dateModified?: string
  datePublished?: string
}

type ParsedSchemaDate = {
  output: string
  time: number
}

const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/
const utcDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

function parseSchemaDate(value: string | undefined): ParsedSchemaDate | null {
  if (!value) {
    return null
  }

  const dateOnlyMatch = dateOnlyPattern.exec(value)

  if (dateOnlyMatch) {
    const date = new Date(`${value}T00:00:00.000Z`)

    if (!Number.isFinite(date.getTime())) {
      return null
    }

    if (date.toISOString().slice(0, 10) !== value) {
      return null
    }

    return {
      output: value,
      time: date.getTime()
    }
  }

  const dateTimeMatch = utcDateTimePattern.exec(value)

  if (!dateTimeMatch) {
    return null
  }

  const date = new Date(value)

  if (!Number.isFinite(date.getTime())) {
    return null
  }

  const sourceDate = `${dateTimeMatch[1]}-${dateTimeMatch[2]}-${dateTimeMatch[3]}`

  if (date.toISOString().slice(0, 10) !== sourceDate) {
    return null
  }

  return {
    output: date.toISOString(),
    time: date.getTime()
  }
}

function comparePublishedDate(a: ParsedSchemaDate, b: ParsedSchemaDate): number {
  return a.time - b.time
}

export function resolveCollectionPageSchemaDates(
  items: readonly PublishedDateSource[]
): CollectionPageSchemaDates {
  const publishedDates = items
    .map(item => parseSchemaDate(item.publishedAt))
    .filter((publishedAt): publishedAt is ParsedSchemaDate => publishedAt !== null)
    .sort(comparePublishedDate)
  if (publishedDates.length === 0) {
    return {}
  }

  return {
    dateModified: publishedDates.at(-1)?.output,
    datePublished: publishedDates[0].output
  }
}
