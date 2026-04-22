export interface ParsedCronSchedule {
    expression: string;
    timezone: string;
    nextRuns: Date[];
    isValid: boolean;
    error?: string;
}
/**
 * Validate a cron expression and return the next N scheduled dates.
 */
export declare function parseCronSchedule(expression: string, timezone?: string, previewCount?: number): ParsedCronSchedule;
/**
 * Return the next scheduled Date after `after` (defaults to now).
 */
export declare function getNextRun(expression: string, timezone?: string, after?: Date): Date | null;
/**
 * Return a human-readable description of a cron expression.
 * Covers common patterns; falls back to the raw expression.
 */
export declare function describeCron(expression: string): string;
//# sourceMappingURL=index.d.ts.map