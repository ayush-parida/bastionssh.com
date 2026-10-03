import { Network } from 'lucide-react';
import ComingSoon from './ComingSoon.js';

/** Apps: the topology graph — Ingress → Service → workload → pods, with config and storage links (K2). */
export default function AppsTab(_props: { clusterId: string; namespace: string }) {
  return (
    <ComingSoon icon={Network} title="App map is coming next">
      A picture of how each app is wired — from its Ingress through Services to its workloads and pods, with broken links
      drawn in red. Until then, the cluster map and Workloads show what is running and whether it is healthy.
    </ComingSoon>
  );
}
