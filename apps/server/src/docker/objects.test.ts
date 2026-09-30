import { describe, it, expect } from 'vitest';
import { toEngineEvent } from './objects.js';

describe('toEngineEvent', () => {
  const raw = (action: string) => ({
    Type: 'container',
    Action: action,
    Actor: { ID: 'a'.repeat(64), Attributes: { name: 'db' } },
    timeNano: 1_700_000_000_000_000_000,
  });

  it('keeps the action and container name', () => {
    expect(toEngineEvent(raw('health_status: healthy'))).toMatchObject({
      type: 'container',
      action: 'health_status: healthy',
      name: 'db',
    });
  });

  it('drops the command line from exec events, which viewers receive', () => {
    for (const action of ['exec_create: sh -c "mysql -ps3cret"', 'exec_start: env TOKEN=s3cret app']) {
      const event = toEngineEvent(raw(action));
      expect(JSON.stringify(event)).not.toContain('s3cret');
      expect(event.action).toBe(action.slice(0, action.indexOf(':')));
    }
    expect(toEngineEvent(raw('exec_die')).action).toBe('exec_die');
  });
});
