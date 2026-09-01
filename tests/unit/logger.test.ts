import { describe, expect, it } from 'vitest';
import { Logger, type LoggerOptions } from '@platform/core';

type Record_ = Record<string, unknown>;

function capture(opts: Partial<Omit<LoggerOptions, 'deploymentId'>> = {}) {
  const lines: string[] = [];
  const logger = new Logger({
    deploymentId: 'dep_test',
    write: (line) => lines.push(line),
    ...opts,
  });

  const parsed = (): Record_[] => lines.map((l) => JSON.parse(l) as Record_);

  /** Indexed access that fails the test loudly instead of returning undefined. */
  const line = (index: number): Record_ => {
    const all = parsed();
    const record = index < 0 ? all[all.length + index] : all[index];
    if (!record) throw new Error(`no log line at index ${index} (have ${all.length})`);
    return record;
  };

  return { logger, lines, parsed, line };
}

describe('Logger', () => {
  it('writes one JSON object per line with the expected shape', () => {
    const { logger, line } = capture();
    logger.info('hello', { extra: 1 });

    expect(line(0)).toMatchObject({
      level: 'info',
      phase: 'bootstrap',
      deploymentId: 'dep_test',
      msg: 'hello',
      extra: 1,
    });
    expect(typeof line(0)['ts']).toBe('string');
  });

  it('binds a phase without losing the parent configuration', () => {
    const { logger, line } = capture();
    logger.phase('install').info('installing');
    logger.info('still bootstrap');

    expect(line(0)['phase']).toBe('install');
    expect(line(1)['phase']).toBe('bootstrap');
  });

  it('redacts secrets from messages and from string fields', () => {
    const token = 'super-secret-token-value';
    const { logger, line } = capture({ redact: [token] });

    logger.info(`the token is ${token}`, { url: `https://x/?t=${token}` });

    const record = line(0);
    expect(String(record['msg'])).not.toContain(token);
    expect(String(record['msg'])).toContain('[redacted]');
    expect(String(record['url'])).not.toContain(token);
  });

  it('ignores short redaction values, which would mangle ordinary output', () => {
    const { logger, line } = capture({ redact: ['ok'] });
    logger.info('looks ok to me');
    expect(line(0)['msg']).toBe('looks ok to me');
  });

  it('truncates a single oversized line', () => {
    const { logger, line } = capture({ maxLineBytes: 32 });
    logger.info('x'.repeat(500));

    const msg = String(line(0)['msg']);
    expect(msg).toContain('[truncated]');
    expect(msg.length).toBeLessThan(100);
  });

  it('stops emitting once the total volume cap is hit, but still reports errors', () => {
    const { logger, lines, parsed, line } = capture({ maxTotalBytes: 400 });

    for (let i = 0; i < 200; i++) logger.info(`line ${i} with some padding text`);
    const afterFlood = lines.length;

    logger.info('this info should be suppressed');
    expect(lines.length).toBe(afterFlood);

    logger.error('but a failure must still be explained');
    expect(lines.length).toBe(afterFlood + 1);

    expect(line(-1)['level']).toBe('error');
    expect(parsed().some((r) => String(r['msg']).includes('log volume cap reached'))).toBe(true);
  });

  it('honours the minimum level', () => {
    const { logger, lines } = capture({ minLevel: 'warn' });
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');
    expect(lines).toHaveLength(2);
  });

  it('labels subprocess output by stream', () => {
    const { logger, line } = capture();
    logger.child('npm warn something', 'stderr');
    expect(line(0)).toMatchObject({ level: 'warn', src: 'stderr' });
  });
});
