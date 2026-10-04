import { useSearchParams } from 'react-router-dom';
import TeamMembers from '@/components/settings/TeamMembers.js';
import PasskeyPolicy from '@/components/settings/PasskeyPolicy.js';
import AccessRequests from '@/components/access/AccessRequests.js';
import SsoSettingsPanel from '@/components/settings/SsoSettings.js';
import RolesPanel from '@/components/access/RolesPanel.js';
import AccessChecker from '@/components/access/AccessChecker.js';
import { cn } from '@/lib/utils.js';
import { useHasRole } from '@/store/auth.js';

const TABS = [
  { id: 'members', label: 'Members' },
  { id: 'roles', label: 'Roles' },
  { id: 'checker', label: 'Access checker' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function TeamPage() {
  const isAdmin = useHasRole('admin');
  const [params, setParams] = useSearchParams();
  // Roles and the checker are admin tools; everyone else only has the members tab
  const requested = params.get('tab') as TabId | null;
  const tab: TabId = isAdmin && requested && TABS.some((t) => t.id === requested) ? requested : 'members';

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-2xl font-bold mb-1">Team &amp; Access</h1>
      <p className="text-muted-foreground text-sm mb-6">
        Who can use this organization, what they may do, and which resources they can reach
      </p>
      {isAdmin && (
        <div role="tablist" aria-label="Team & Access" className="mb-8 flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setParams(t.id === 'members' ? {} : { tab: t.id }, { replace: true })}
              className={cn(
                '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {tab === 'members' && (
        <>
          <PasskeyPolicy />
          <AccessRequests />
          <SsoSettingsPanel />
          <TeamMembers />
        </>
      )}
      {tab === 'roles' && <RolesPanel />}
      {tab === 'checker' && <AccessChecker />}
    </div>
  );
}
