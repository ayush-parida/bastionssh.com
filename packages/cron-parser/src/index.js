import { Cron } from 'croner';
/**
 * Validate a cron expression and return the next N scheduled dates.
 */
export function parseCronSchedule(expression, timezone = 'UTC', previewCount = 5) {
    try {
        const job = new Cron(expression, { timezone, maxRuns: previewCount + 1 });
        const nextRuns = [];
        let next = job.nextRun();
        while (next && nextRuns.length < previewCount) {
            nextRuns.push(next);
            next = job.nextRun(next);
        }
        return { expression, timezone, nextRuns, isValid: true };
    }
    catch (err) {
        return {
            expression,
            timezone,
            nextRuns: [],
            isValid: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
/**
 * Return the next scheduled Date after `after` (defaults to now).
 */
export function getNextRun(expression, timezone = 'UTC', after = new Date()) {
    try {
        const job = new Cron(expression, { timezone });
        return job.nextRun(after) ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Return a human-readable description of a cron expression.
 * Covers common patterns; falls back to the raw expression.
 */
export function describeCron(expression) {
    const parts = expression.trim().split(/\s+/);
    if (parts.length < 5)
        return expression;
    const [minute, hour, dom, month, dow] = parts;
    if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*')
        return 'Every minute';
    if (minute !== '*' && hour === '*' && dom === '*' && month === '*' && dow === '*')
        return `Every hour at minute ${minute}`;
    if (minute !== '*' && hour !== '*' && dom === '*' && month === '*' && dow === '*')
        return `Daily at ${hour}:${minute.padStart(2, '0')}`;
    if (minute !== '*' && hour !== '*' && dom === '*' && month === '*' && dow !== '*')
        return `Weekly on weekday ${dow} at ${hour}:${minute.padStart(2, '0')}`;
    if (minute !== '*' && hour !== '*' && dom !== '*' && month === '*' && dow === '*')
        return `Monthly on day ${dom} at ${hour}:${minute.padStart(2, '0')}`;
    return expression;
}
//# sourceMappingURL=index.js.map