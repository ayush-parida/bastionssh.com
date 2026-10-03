import { History } from 'lucide-react';
import ComingSoon from './ComingSoon.js';

/** Events: a timeline grouped by object, warnings first, repeats collapsed (K2). */
export default function EventsTab(_props: { clusterId: string; namespace: string }) {
  return (
    <ComingSoon icon={History} title="Events timeline is coming next">
      What Kubernetes reported recently — pulls, restarts, scheduling failures — grouped by object, with warnings highlighted
      and repeats collapsed.
    </ComingSoon>
  );
}
