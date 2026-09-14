import { Injectable, type LoggerService, type LogLevel } from '@nestjs/common';

import { getTenantContext } from '../tenancy/tenant-context';

/**
 * Structured JSON logging (docs/11 §8).
 *
 * JSON rather than pretty text because these lines are queried, not read: "show me every
 * request for household X that took over 300 ms" is a log query, not a grep. A `requestId` is
 * attached to every line and propagated to AI calls, so "why did this Transaction get this
 * Category?" is answerable from logs alone.
 *
 * Never logged: credentials, tokens, full receipt text, or anything from a model prompt body
 * (docs/08 §10). Log identifiers and outcomes, not payloads.
 */
@Injectable()
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.write('error', message, context, stack);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  /** NestJS calls this on bootstrap to declare which levels are enabled. */
  setLogLevels(_levels: LogLevel[]): void {
    // Level filtering is handled by the host; this logger emits everything it is given.
  }

  private write(level: string, message: unknown, context?: string, stack?: string): void {
    const tenant = getTenantContext();
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      context: context ?? 'Application',
      msg: typeof message === 'string' ? message : safeInspect(message),
    };

    if (tenant) {
      record['requestId'] = tenant.requestId;
      record['householdId'] = tenant.householdId;
      record['userId'] = tenant.userId;
    }
    if (stack) record['stack'] = stack;

    const line = JSON.stringify(record);
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }
}

/** Avoid throwing from inside the logger if a caller logs something circular. */
function safeInspect(value: unknown): string {
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return '[unserialisable]';
  }
}
