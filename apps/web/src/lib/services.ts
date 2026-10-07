/** Where the app links into the quick-services docs (each template's own page is `/docs/deployments/<template.docs>`). */
export const SERVICE_DOCS = {
  overview: '/docs/deployments/services-overview',
  exposing: '/docs/deployments/services-overview#exposing-a-service',
  backups: '/docs/deployments/services-overview#backups',
  restoring: '/docs/deployments/services-overview#restoring-a-backup',
  noBackups: '/docs/deployments/services-others#backups',
} as const;

/** A template's docs page, or a section of it (`upgrading`). */
export const serviceDocs = (slug: string, anchor?: string) => `/docs/deployments/${slug}${anchor ? `#${anchor}` : ''}`;
