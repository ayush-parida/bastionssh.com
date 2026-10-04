import { MODULES, type ModuleDefinition, type ModuleKey, type ModuleLevel, type ModulePermissions } from '@smt/shared';
import { cn } from '@/lib/utils.js';

/**
 * The role editor's Modules section (unified roles spec §3, §5): one row per
 * module, a column per level — None, View, Operate, Manage — with what the
 * picked level allows in plain words. Resource modules first, then the
 * organization's features, then Team & Access as its three parts (members,
 * roles, sign-in & SSO), so inviting people can be given without editing
 * roles. A level a module does not use is not offered.
 */

const COLUMNS: { level: ModuleLevel; label: string }[] = [
  { level: 'none', label: 'None' },
  { level: 'view', label: 'View' },
  { level: 'operate', label: 'Operate' },
  { level: 'manage', label: 'Manage' },
];

const GROUPS: { title: string; hint: string; modules: ModuleDefinition[] }[] = [
  {
    title: 'Resources',
    hint: 'Which items they reach comes from the resources below; Manage adds creating new ones.',
    modules: MODULES.filter((m) => m.kind === 'resource'),
  },
  { title: 'Organization', hint: '', modules: MODULES.filter((m) => m.kind === 'org' && !m.group) },
  {
    title: 'Team & Access',
    hint: 'Three parts, so a role can invite people without editing roles.',
    modules: MODULES.filter((m) => m.group === 'team'),
  },
];

/** What `level` on `module` allows, in plain words. */
export function moduleHint(module: ModuleDefinition, level: ModuleLevel): string {
  if (level === 'none') return module.kind === 'resource' ? 'Hidden — any resources granted stay parked' : 'Hidden';
  return module.hints[level as Exclude<ModuleLevel, 'none'>] ?? '';
}

export function ModulesGrid({
  value,
  onChange,
  readOnly = false,
  parked = new Set(),
}: {
  value: ModulePermissions;
  onChange: (next: ModulePermissions) => void;
  readOnly?: boolean;
  /** Modules with resources granted while the module is off: said so on their row. */
  parked?: Set<ModuleKey>;
}) {
  const set = (key: ModuleKey, level: ModuleLevel) => {
    const next = { ...value };
    if (level === 'none') delete next[key];
    else next[key] = level;
    onChange(next);
  };

  return (
    <div className="overflow-x-auto rounded-md border border-border" data-testid="modules-grid">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Module</th>
            {COLUMNS.map((c) => (
              <th key={c.level} className="px-2 py-2 text-center font-medium">{c.label}</th>
            ))}
          </tr>
        </thead>
        {GROUPS.map((group) => (
          <tbody key={group.title} className="divide-y divide-border border-b border-border last:border-b-0">
            <tr className="bg-muted/40">
              <th colSpan={COLUMNS.length + 1} className="px-3 py-1.5 text-left text-xs font-semibold">
                {group.title}
                {group.hint && <span className="ml-2 font-normal text-muted-foreground">{group.hint}</span>}
              </th>
            </tr>
            {group.modules.map((m) => {
              const held = value[m.key] ?? 'none';
              return (
                <tr key={m.key} role="radiogroup" aria-label={m.label}>
                  <td className={cn('px-3 py-2', m.group && 'pl-6')}>
                    <span className="font-medium">{m.label}</span>
                    <span className="block text-xs text-muted-foreground" data-testid={`module-hint-${m.key}`}>
                      {moduleHint(m, held)}
                      {parked.has(m.key) && held === 'none' && (
                        <span className="ml-1 text-amber-600 dark:text-amber-400">— resources below are parked</span>
                      )}
                    </span>
                  </td>
                  {COLUMNS.map((c) => {
                    const offered = c.level === 'none' || (m.levels as readonly ModuleLevel[]).includes(c.level);
                    return (
                      <td key={c.level} className="px-2 py-2 text-center">
                        {offered ? (
                          <input
                            type="radio"
                            name={`module-${m.key}`}
                            aria-label={`${m.label}: ${c.label}`}
                            title={moduleHint(m, c.level)}
                            checked={held === c.level}
                            disabled={readOnly}
                            onChange={() => set(m.key, c.level)}
                            className="size-4 accent-primary"
                          />
                        ) : (
                          <span className="text-muted-foreground/40" aria-hidden>
                            —
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}
