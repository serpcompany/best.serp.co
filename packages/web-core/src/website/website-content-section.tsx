import { Info } from 'lucide-react';
import type { MDXComponents } from 'mdx/types';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getCategoryDisplayName } from '../category-display';
import type { WebsiteMetadata } from '../content-query';
import { siteCopy } from '../site-copy';

export interface WebsiteContentSectionProps {
  mdxComponents: MDXComponents;
  website: WebsiteMetadata;
}

function stripDuplicateLinksSection(
  content: string,
  hasSupplementalLinks: boolean
): string {
  if (!hasSupplementalLinks) {
    return content;
  }

  return content.replace(/\n## Links[\s\S]*$/i, '').trim();
}

function stripHtmlTags(html: string | null | undefined): string {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').trim();
}

export function WebsiteContentSection({
  website,
  mdxComponents,
}: WebsiteContentSectionProps) {
  const categoryLabels = [
    ...(website.category ? [website.category] : []),
    ...(website.categories || []),
  ]
    .filter(
      (value, index, values) =>
        Boolean(value) && values.indexOf(value) === index
    )
    .map((categorySlug) => getCategoryDisplayName(categorySlug));
  const featuredImageUrl = website.media?.images?.[0];

  if (website.content) {
    const renderedContent = stripDuplicateLinksSection(
      website.content,
      Boolean(website.resourceLinks?.length)
    );

    return (
      <section className="animate-fade-in-up opacity-0 stagger-4">
        {featuredImageUrl ? (
          <div className="mb-8 overflow-hidden rounded-2xl border border-border/50 bg-card/50">
            <img
              src={featuredImageUrl}
              alt={`${website.name} featured image`}
              className="h-auto w-full object-cover"
            />
          </div>
        ) : null}
        <div className="prose max-w-none prose-headings:scroll-mt-20 dark:prose-invert">
          <ReactMarkdown
            components={mdxComponents as Components}
            remarkPlugins={[remarkGfm]}
          >
            {renderedContent}
          </ReactMarkdown>
        </div>
      </section>
    );
  }

  return (
    <section
      className="animate-fade-in-up space-y-8 opacity-0 stagger-4"
      aria-labelledby="about-heading"
    >
      {featuredImageUrl ? (
        <div className="overflow-hidden rounded-2xl border border-border/50 bg-card/50">
          <img
            src={featuredImageUrl}
            alt={`${website.name} featured image`}
            className="h-auto w-full object-cover"
          />
        </div>
      ) : null}
      <div className="rounded-2xl border border-border/50 bg-card/50 p-6 backdrop-blur-sm md:p-8">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Info className="size-5 text-primary" aria-hidden />
          </div>
          <div>
            <h2
              className="scroll-mt-20 text-xl font-bold text-pretty"
              id="about-heading"
            >
              About {website.name}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Summary and key details
            </p>
          </div>
        </div>
        <p className="text-pretty leading-relaxed text-muted-foreground">
          {stripHtmlTags(website.description)} Browse this{' '}
          {siteCopy.listingName.singular} for resource links, category context,
          and key details that help visitors evaluate it quickly.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {[
          {
            label: categoryLabels.length > 1 ? 'Categories' : 'Category',
            value:
              categoryLabels.length > 0 ? categoryLabels.join(', ') : 'General',
            className: '',
          },
          { label: 'Type', value: siteCopy.listingName.singularTitle },
          { label: 'Resources', value: 'Helpful links and context' },
          {
            label: 'Added',
            value: website.publishedAt
              ? new Date(website.publishedAt).toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })
              : 'Recently',
          },
        ].map(({ label, value, className = '' }) => (
          <div
            key={label}
            className="space-y-1 rounded-2xl border border-border/50 bg-card/50 p-5 backdrop-blur-sm transition-colors hover:border-border"
          >
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {label}
            </span>
            <p className={`text-base font-semibold ${className}`}>{value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
