import type { ServiceIcon as IconName } from '@smt/shared';
import { Activity, BarChart3, Database, Gauge, HardDrive, Layers, Mail, Rabbit, Search, Table, Zap, type LucideIcon } from 'lucide-react';

const ICONS: Record<IconName, LucideIcon> = {
  database: Database,
  zap: Zap,
  layers: Layers,
  'hard-drive': HardDrive,
  rabbit: Rabbit,
  search: Search,
  'bar-chart': BarChart3,
  mail: Mail,
  table: Table,
  gauge: Gauge,
  activity: Activity,
};

/** A quick-service template's icon (the catalog names it; unknown names fall back to a database). */
export default function ServiceIcon({ icon, size = 16, className }: { icon: IconName | undefined; size?: number; className?: string }) {
  const Icon = (icon && ICONS[icon]) || Database;
  return <Icon size={size} className={className} aria-hidden="true" />;
}
