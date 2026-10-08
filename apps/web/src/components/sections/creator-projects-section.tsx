'use client'

import { ExternalLink, Github, Star } from 'lucide-react'
import type { ReactNode } from 'react'

interface Project {
  description: string
  githubUrl?: string
  name: string
  stars?: number
  tags: string[]
  url: string
}

interface SectionProps {
  children: ReactNode
  description?: string
  title: string
  titleId?: string
}

interface ButtonProps {
  asChild?: boolean
  children: ReactNode
  size?: 'sm'
  variant?: 'outline'
}

interface BadgeProps {
  children: ReactNode
  className?: string
  variant?: 'secondary'
}

interface CardProps {
  children: ReactNode
  className?: string
}

interface CardSectionProps {
  children: ReactNode
  className?: string
}

interface CreatorProjectsSectionProps {
  onProjectClick?: (
    name: string,
    url: string,
    destination: 'github' | 'visit-site',
    source?: string
  ) => void
  slots: {
    Badge: React.ComponentType<BadgeProps>
    Button: React.ComponentType<ButtonProps>
    Card: React.ComponentType<CardProps>
    CardContent: React.ComponentType<CardSectionProps>
    CardDescription: React.ComponentType<CardSectionProps>
    CardHeader: React.ComponentType<CardSectionProps>
    CardTitle: React.ComponentType<CardSectionProps>
    Section: React.ComponentType<SectionProps>
  }
}

const projects: Project[] = [
  {
    name: 'Front-End Checklist',
    description:
      'The perfect Front-End Checklist for modern websites and meticulous developers.',
    url: 'https://frontendchecklist.io',
    githubUrl: 'https://github.com/thedaviddias/Front-End-Checklist',
    stars: 71954,
    tags: ['Frontend', 'Checklist', 'Best Practices'],
  },
  {
    name: 'UX Patterns for Developers',
    description:
      'Collection of UX patterns for everyone but specially towards developers who want to understand how to build effective UI components accessible and usable.',
    url: 'https://github.com/thedaviddias/ux-patterns-for-developers',
    githubUrl: 'https://github.com/thedaviddias/ux-patterns-for-developers',
    stars: 155,
    tags: ['UX', 'Design Patterns', 'Accessibility'],
  },
  {
    name: 'Indie Dev Toolkit',
    description:
      'A curated list of tools and resources for indie hackers, solo founders, and bootstrapped startups.',
    url: 'https://github.com/thedaviddias/indie-dev-toolkit',
    githubUrl: 'https://github.com/thedaviddias/indie-dev-toolkit',
    stars: 222,
    tags: ['Toolkit', 'Indie Hacking', 'Resources'],
  },
]

export function CreatorProjectsSection({
  onProjectClick,
  slots,
}: CreatorProjectsSectionProps) {
  const {
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Section,
  } = slots

  return (
    <Section
      title="More Projects by the Creator"
      description="Explore other open-source projects and resources by David Dias"
    >
      <div className="space-y-6">
        <div className="grid gap-4 sm:gap-6 md:grid-cols-2 lg:grid-cols-3">
          {projects.map(project => (
            <Card
              key={project.name}
              className="relative group flex flex-col transition-all duration-200 hover:shadow-lg"
            >
              <CardHeader className="flex-1 pb-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-lg transition-colors group-hover:text-primary">
                      {project.name}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      {project.stars ? (
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                          <Star className="h-3 w-3" />
                          <span>{project.stars.toLocaleString()}</span>
                        </div>
                      ) : null}
                      <div className="flex flex-wrap gap-1">
                        {project.tags.slice(0, 2).map(tag => (
                          <Badge key={tag} variant="secondary" className="px-2 py-0.5 text-xs">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
                <CardDescription className="text-sm leading-relaxed">
                  {project.description}
                </CardDescription>
              </CardHeader>

              <CardContent className="mt-auto pt-0">
                <div className="flex items-center gap-2">
                  <Button size="sm" asChild>
                    <a
                      href={project.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5"
                      onClick={() => {
                        onProjectClick?.(project.name, project.url, 'visit-site')
                      }}
                    >
                      <ExternalLink className="h-3 w-3" />
                      Visit Site
                    </a>
                  </Button>
                  {project.githubUrl ? (
                    <Button size="sm" variant="outline" asChild>
                      <a
                        href={project.githubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5"
                        onClick={() => {
                          onProjectClick?.(
                            project.name,
                            project.githubUrl as string,
                            'github'
                          )
                        }}
                      >
                        <Github className="h-3 w-3" />
                        GitHub
                      </a>
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="border-t border-border/50 pt-4 text-center">
          <p className="mb-3 text-sm text-muted-foreground">
            Like these projects? Check out David&apos;s GitHub for more open-source
            contributions.
          </p>
          <Button variant="outline" asChild>
            <a
              href="https://github.com/thedaviddias"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2"
              onClick={() => {
                onProjectClick?.(
                  'David Dias Profile',
                  'https://github.com/thedaviddias',
                  'github',
                  'follow-cta'
                )
              }}
            >
              <Github className="h-4 w-4" />
              Follow on GitHub
            </a>
          </Button>
        </div>
      </div>
    </Section>
  )
}
