import { HardDrive } from 'lucide-react';
import ComingSoon from './ComingSoon.js';

/** Storage: claims, volumes and storage classes, and which pods use them (K2). */
export default function StorageTab(_props: { clusterId: string; namespace: string }) {
  return (
    <ComingSoon icon={HardDrive} title="Storage view is coming next">
      Persistent volume claims, the volumes behind them and the pods that mount them — with claims that never got storage
      called out.
    </ComingSoon>
  );
}
