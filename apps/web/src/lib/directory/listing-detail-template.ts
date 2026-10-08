export const supportedListingDetailTemplates = ['default', 'movie', 'person', 'product'] as const;

export type ListingDetailTemplate = (typeof supportedListingDetailTemplates)[number];

const entityTypeToTemplate: Record<string, ListingDetailTemplate> = {
  movie: 'movie',
  person: 'person',
  product: 'product',
};

export function resolveListingDetailTemplate(entityType?: string): ListingDetailTemplate {
  if (!entityType) {
    return 'default';
  }

  return entityTypeToTemplate[entityType] || 'default';
}
