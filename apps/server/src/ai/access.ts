import { hasModule } from '../auth/access/modules.js';
import { resolveAccess, type AccessSubject } from '../auth/access/resolve.js';

/**
 * Who may use the AI assistant (unified roles spec §3.2): the AI Assistant
 * module at `view` — which members who operated something before modules
 * existed keep (auth/access/resolve.ts). It widens nothing: every tool still
 * checks the member's level on its own target, and the prompt lists only
 * what they can see. Read-only API tokens never chat. Asked by the routes and
 * again before every tool call, so turning the module off stops a
 * conversation already running.
 */
export function canUseAssistant(who: AccessSubject): boolean {
  return !resolveAccess(who).readOnly && hasModule(who, 'ai', 'view');
}

export const ASSISTANT_OFF = 'The AI assistant is not available to you';
