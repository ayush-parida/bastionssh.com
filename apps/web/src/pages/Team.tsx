import TeamMembers from '@/components/settings/TeamMembers.js';
import PasskeyPolicy from '@/components/settings/PasskeyPolicy.js';
import SsoSettingsPanel from '@/components/settings/SsoSettings.js';

export default function TeamPage() {
  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-2xl font-bold mb-1">Team &amp; Access</h1>
      <p className="text-muted-foreground text-sm mb-8">
        Who can use this organization, what they may do, and which servers they can reach
      </p>
      <PasskeyPolicy />
      <SsoSettingsPanel />
      <TeamMembers />
    </div>
  );
}
