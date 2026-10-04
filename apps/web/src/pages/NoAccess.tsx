import { useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Lock, SearchX, Settings } from 'lucide-react';
import { RequestAccessDialog, useRequestableAccess } from '@/components/access/RequestAccessDialog.js';

/**
 * What a member sees where there is nothing for them (unified roles spec
 * §2.3, §5): the home of someone who holds No access (or no role at all),
 * and the page a hidden module's deep link lands on. Both offer "Request
 * access" when the org takes requests, and their own account settings —
 * which every member keeps.
 */

function RequestAccessButton() {
  const [open, setOpen] = useState(false);
  const { data } = useRequestableAccess();
  if (!data?.canRequest) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        <KeyRound size={14} /> Request access
      </button>
      {open && <RequestAccessDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function AccountLink() {
  return (
    <Link to="/settings" className="flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
      <Settings size={14} /> Account settings
    </Link>
  );
}

/** Home for a member who can see no module at all. */
export function NoAccessHome() {
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="no-access-home">
      <div className="max-w-md text-center">
        <Lock size={40} className="mx-auto mb-4 text-muted-foreground opacity-40" />
        <h1 className="mb-2 text-xl font-semibold">You don&apos;t have access to anything yet</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Your roles in this organization give you nothing to use so far. Ask an admin to give you a role — you can still
          manage your own account: password, passkeys, sessions and backup codes.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <RequestAccessButton />
          <AccountLink />
        </div>
      </div>
    </div>
  );
}

/** A page of a module that is off or empty for the member: as if it were not there. */
export function ModuleNotFound() {
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="module-not-found">
      <div className="max-w-md text-center">
        <SearchX size={40} className="mx-auto mb-4 text-muted-foreground opacity-40" />
        <h1 className="mb-2 text-xl font-semibold">Page not found</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          There is nothing here for you — it does not exist, or your roles do not include it. If you need it, ask for access.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <RequestAccessButton />
          <Link to="/" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
