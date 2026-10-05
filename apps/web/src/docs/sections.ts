import type { ElementType } from 'react';
import { Activity, Bot, Compass, Container, FolderOpen, KeyRound, Rocket, Server, ShieldCheck, ShipWheel, Wrench } from 'lucide-react';

/**
 * The sections of the in-app docs (Docs page). Pages are markdown files at
 * `src/docs/<section>/<slug>.md` whose frontmatter names the section; a
 * section with no pages yet is left out of the navigation.
 */
export interface DocSection {
  /** The folder name and the URL segment: `/docs/<id>/<slug>`. */
  id: string;
  title: string;
  icon: ElementType;
  order: number;
  /** One line under the title on the docs home. */
  description: string;
}

export const DOC_SECTIONS: readonly DocSection[] = [
  { id: 'getting-started', title: 'Getting started', icon: Compass, order: 0, description: 'Install, sign in and add your first server.' },
  { id: 'servers', title: 'Servers', icon: Server, order: 10, description: 'Adding servers, terminals, credentials and jump hosts.' },
  { id: 'files', title: 'Files', icon: FolderOpen, order: 20, description: 'Browsing and transferring files over SFTP, FTP and object storage.' },
  { id: 'docker', title: 'Docker', icon: Container, order: 30, description: 'Containers, images and Compose projects on your servers.' },
  { id: 'deployments', title: 'Deployments', icon: Rocket, order: 40, description: 'Deploy static sites, Next.js and Dockerfile apps to your own servers.' },
  { id: 'kubernetes', title: 'Kubernetes', icon: ShipWheel, order: 50, description: 'Cluster maps, workloads, diagnosis and guided actions.' },
  { id: 'monitoring', title: 'Monitoring', icon: Activity, order: 60, description: 'Health checks, metrics, alerts and notification channels.' },
  { id: 'access', title: 'Access', icon: KeyRound, order: 70, description: 'Members, roles, modules and access requests.' },
  { id: 'security', title: 'Security', icon: ShieldCheck, order: 80, description: 'Passkeys, SSO, audit log, recordings and secrets.' },
  { id: 'operations', title: 'Operations', icon: Wrench, order: 90, description: 'Running BastionSSH itself: configuration, backups and upgrades.' },
  { id: 'ai', title: 'AI', icon: Bot, order: 100, description: 'The AI assistant, providers and what it may do.' },
];

export function docSection(id: string): DocSection | undefined {
  return DOC_SECTIONS.find((s) => s.id === id);
}
