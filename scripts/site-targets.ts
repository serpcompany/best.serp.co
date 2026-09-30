export const siteIds = ['pornvideodownloaders.com', 'serp.software'] as const
export type SiteId = (typeof siteIds)[number]
export const replatformPreviewRef = 'refs/heads/main' as const

export interface SiteTarget {
  activePreview: {
    accountId: string
    databaseId: string
    databaseName: string
    workerName: string
  }
  appPackageName: SiteId
  artifactBatchDirectory: string
  confirmation: {
    deploy: {
      preview: string
      production: string
    }
    plan: {
      preview: string
      production: string
    }
    publish: string
    replatform: {
      preview: string
      production: string
    }
    submission: string
  }
  local: {
    configPath: string
    databaseId: string
    databaseName: string
    workerName: string
  }
  parityReportPath: string
  protectedEnvironment: {
    preview: string
    production: string
  }
  remote: {
    previewConfigPath: string
    productionConfigPath: string
  }
  replatform: {
    allowMissingPreviewWorkerBootstrap: boolean
    previewDatabaseName: string
    previewProvisioningConfirmation?: string
    previewConfigPath: string
    productionDatabaseName: string
    productionProvisioningConfirmation: string
    productionConfigPath: string
  }
  siteId: SiteId
}

export const siteTargets = {
  'pornvideodownloaders.com': {
    activePreview: {
      accountId: 'cec5f04e1d18bcc65f2be0aefb04f059',
      databaseId: '16ede356-3caa-4cea-93f3-69f5b208b1d7',
      databaseName: 'pornvideodownloaders-replatform-preview',
      workerName: 'pornvideodownloaders-preview'
    },
    appPackageName: 'pornvideodownloaders.com',
    artifactBatchDirectory: 'd1/artifacts/pornvideodownloaders-com-v1-import',
    confirmation: {
      deploy: {
        preview: 'deploy-pornvideodownloaders.com-preview',
        production: 'deploy-pornvideodownloaders.com-production'
      },
      plan: {
        preview: 'plan-pornvideodownloaders.com-preview',
        production: 'plan-pornvideodownloaders.com-production'
      },
      publish: 'publish-pornvideodownloaders.com-production',
      replatform: {
        preview: 'rehearse-pornvideodownloaders.com-preview',
        production: 'cutover-pornvideodownloaders.com-production'
      },
      submission: 'approve-pornvideodownloaders.com-submission-production'
    },
    local: {
      configPath: 'configs/wrangler/pornvideodownloaders.com/local.jsonc',
      databaseId: '00000000-0000-0000-0000-000000000168',
      databaseName: 'pornvideodownloaders-local',
      workerName: 'pornvideodownloaders-local'
    },
    parityReportPath: 'd1/artifacts/pornvideodownloaders-com-v1-parity.yaml',
    protectedEnvironment: {
      preview: 'pornvideodownloaders-preview',
      production: 'pornvideodownloaders-production'
    },
    remote: {
      previewConfigPath: 'configs/wrangler/pornvideodownloaders.com/preview.jsonc',
      productionConfigPath: 'configs/wrangler/pornvideodownloaders.com/production.jsonc'
    },
    replatform: {
      allowMissingPreviewWorkerBootstrap: false,
      previewDatabaseName: 'pornvideodownloaders-replatform-preview',
      previewProvisioningConfirmation: 'provision-pornvideodownloaders.com-replacement-preview',
      previewConfigPath: 'configs/wrangler/pornvideodownloaders.com/replatform-preview.jsonc',
      productionDatabaseName: 'pornvideodownloaders-replatform-production',
      productionProvisioningConfirmation:
        'provision-pornvideodownloaders.com-replacement-production',
      productionConfigPath: 'configs/wrangler/pornvideodownloaders.com/replatform-production.jsonc'
    },
    siteId: 'pornvideodownloaders.com'
  },
  'serp.software': {
    activePreview: {
      accountId: 'cec5f04e1d18bcc65f2be0aefb04f059',
      databaseId: '29c0a6ed-e824-459c-b088-6098fdbf1abf',
      databaseName: 'serp-software-replatform-preview',
      workerName: 'serp-software-replatform-preview'
    },
    appPackageName: 'serp.software',
    artifactBatchDirectory: 'd1/artifacts/serp-software-v1-import',
    confirmation: {
      deploy: {
        preview: 'deploy-serp.software-preview',
        production: 'deploy-serp.software-production'
      },
      plan: {
        preview: 'plan-serp.software-preview',
        production: 'plan-serp.software-production'
      },
      publish: 'publish-serp.software-production',
      replatform: {
        preview: 'rehearse-serp.software-preview',
        production: 'cutover-serp.software-production'
      },
      submission: 'approve-serp.software-submission-production'
    },
    local: {
      configPath: 'configs/wrangler/serp.software/local.jsonc',
      databaseId: '00000000-0000-0000-0000-000000000068',
      databaseName: 'serp-software-local',
      workerName: 'serp-software-local'
    },
    parityReportPath: 'd1/artifacts/serp-software-v1-parity.yaml',
    protectedEnvironment: {
      preview: 'serp-software-preview',
      production: 'production'
    },
    remote: {
      previewConfigPath: 'configs/wrangler/serp.software/preview.jsonc',
      productionConfigPath: 'configs/wrangler/serp.software/production.jsonc'
    },
    replatform: {
      allowMissingPreviewWorkerBootstrap: false,
      previewDatabaseName: 'serp-software-replatform-preview',
      previewConfigPath: 'configs/wrangler/serp.software/replatform-preview.jsonc',
      productionDatabaseName: 'serp-software-replatform-production',
      productionProvisioningConfirmation: 'provision-serp.software-replacement-production',
      productionConfigPath: 'configs/wrangler/serp.software/replatform-production.jsonc'
    },
    siteId: 'serp.software'
  }
} satisfies Record<SiteId, SiteTarget>

export function parseSiteId(value: string | undefined): SiteId {
  if (siteIds.includes(value as SiteId)) return value as SiteId
  throw new Error(`Site must be one of: ${siteIds.join(', ')}.`)
}

export function resolveSiteTarget(value: string | undefined): SiteTarget {
  return siteTargets[parseSiteId(value)]
}
