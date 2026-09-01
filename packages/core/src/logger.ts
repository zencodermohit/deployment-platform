/**
 * Structured JSON logging with secret redaction and hard volume caps.
 *
 * One JSON object per line to stdout. In AWS this is picked up verbatim by the
 * awslogs driver; locally you can read it with `| jq`. See docs/04-build-contract.md.
 *
 * Two caps exist because the log stream is attacker-influenced: a malicious repo
 * that prints forever must not generate an unbounded CloudWatch bill.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  deploymentId: string;
  /** Values to scrub from every line. Short values are ignored to avoid mangling output. */
  redact?: string[];
  minLevel?: Level;
  maxLineBytes?: number;
  maxTotalBytes?: number;
  write?: (line: string) => void;
  now?: () => Date;
}

export interface LogFields {
  [key: string]: unknown;
}

const MIN_REDACTABLE_LENGTH = 8;

export class Logger {
  private readonly deploymentId: string;
  private readonly secrets: string[];
  private readonly minLevel: number;
  private readonly maxLineBytes: number;
  private readonly maxTotalBytes: number;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  private totalBytes = 0;
  private capReached = false;
  private currentPhase: string;

  constructor(opts: LoggerOptions, phase = 'bootstrap') {
    this.deploymentId = opts.deploymentId;
    this.secrets = (opts.redact ?? []).filter((s) => s.length >= MIN_REDACTABLE_LENGTH);
    this.minLevel = LEVEL_ORDER[opts.minLevel ?? 'info'];
    this.maxLineBytes = opts.maxLineBytes ?? 8 * 1024;
    this.maxTotalBytes = opts.maxTotalBytes ?? 10 * 1024 * 1024;
    this.write = opts.write ?? ((line) => process.stdout.write(line + '\n'));
    this.now = opts.now ?? (() => new Date());
    this.currentPhase = phase;
  }

  /** A logger bound to a build phase. Shares byte counters with its parent. */
  phase(name: string): Logger {
    const child = Object.create(this) as Logger;
    Reflect.set(child, 'currentPhase', name);
    return child;
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit('error', msg, fields);
  }

  /** A line of raw subprocess output (npm, vite). Never trusted, always redacted. */
  child(msg: string, stream: 'stdout' | 'stderr'): void {
    this.emit(stream === 'stderr' ? 'warn' : 'info', msg, { src: stream });
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      out = out.split(secret).join('[redacted]');
    }
    return out;
  }

  private emit(level: Level, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    // Past the cap, only errors get through, so a failure is always explained.
    if (this.capReached && level !== 'error') return;

    const record: Record<string, unknown> = {
      ts: this.now().toISOString(),
      level,
      phase: this.currentPhase,
      deploymentId: this.deploymentId,
      msg: this.truncate(this.redact(msg)),
    };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (k in record) continue;
        record[k] = typeof v === 'string' ? this.truncate(this.redact(v)) : v;
      }
    }

    const line = JSON.stringify(record);
    this.totalBytes += Buffer.byteLength(line, 'utf8') + 1;

    if (this.totalBytes > this.maxTotalBytes && !this.capReached) {
      this.capReached = true;
      this.write(line);
      this.write(
        JSON.stringify({
          ts: this.now().toISOString(),
          level: 'warn',
          phase: this.currentPhase,
          deploymentId: this.deploymentId,
          msg: 'log volume cap reached; suppressing further output',
          maxTotalBytes: this.maxTotalBytes,
        }),
      );
      return;
    }

    this.write(line);
  }

  private truncate(text: string): string {
    if (Buffer.byteLength(text, 'utf8') <= this.maxLineBytes) return text;
    return Buffer.from(text, 'utf8').subarray(0, this.maxLineBytes).toString('utf8') + '…[truncated]';
  }
}
