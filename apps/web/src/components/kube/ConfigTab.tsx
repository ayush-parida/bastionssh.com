import { FileCog } from 'lucide-react';
import ComingSoon from './ComingSoon.js';

/** Config: ConfigMaps and Secrets (names and keys only) and who uses them (K2). */
export default function ConfigTab(_props: { clusterId: string; namespace: string }) {
  return (
    <ComingSoon icon={FileCog} title="Config view is coming next">
      ConfigMaps and Secrets with the workloads that read them. Secret values are never shown — only their names and keys.
    </ComingSoon>
  );
}
