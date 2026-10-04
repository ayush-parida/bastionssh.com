import { useQuery } from '@tanstack/react-query';
import type { AIAccess } from '@smt/shared';
import { api } from '@/lib/api.js';
import { useModule } from '@/hooks/useModules.js';

/**
 * Whether the signed-in member may use the AI assistant: the AI Assistant
 * module, or a custom role or personal grant that lets them operate at least
 * one server or cluster namespace (custom roles spec §5). The server answers
 * with the rule its chat and approvals enforce. Until it has, the assistant
 * stays hidden from members without the module. UI-side only.
 */
export function useAssistantAccess(): boolean {
  const hasModule = useModule('ai', 'view');
  const { data } = useQuery<AIAccess>({
    queryKey: ['ai-access'],
    queryFn: () => api.get('/ai/access'),
    enabled: !hasModule,
    staleTime: 30_000,
  });
  return hasModule || !!data?.chat;
}
