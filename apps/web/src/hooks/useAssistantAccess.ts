import { useQuery } from '@tanstack/react-query';
import type { AIAccess } from '@smt/shared';
import { api } from '@/lib/api.js';
import { useHasRole } from '@/store/auth.js';

/**
 * Whether the signed-in member may use the AI assistant: operators and up,
 * or anyone a custom role or personal grant lets operate at least one server
 * or cluster namespace (custom roles spec §5). The server answers with the
 * rule its chat and approvals enforce. Until it has, the assistant stays
 * hidden from members below operator. UI-side only.
 */
export function useAssistantAccess(): boolean {
  const isOperator = useHasRole('operator');
  const { data } = useQuery<AIAccess>({
    queryKey: ['ai-access'],
    queryFn: () => api.get('/ai/access'),
    enabled: !isOperator,
    staleTime: 30_000,
  });
  return isOperator || !!data?.chat;
}
