import { useEffect, useRef, useState } from 'react';
import { api, isTerminal, type DeploymentStatus, type LogLine } from '../api';

/**
 * Incremental log tail.
 *
 * Polls only while the deployment is live, and only asks for lines newer than
 * the last it has (the `since` cursor the endpoint hands back), so a long build
 * is not re-fetched in full every two seconds. Stops the moment the deployment
 * is terminal — a finished build writes no more lines.
 */
export function Logs({
  deploymentId,
  status,
}: {
  deploymentId: string;
  status: DeploymentStatus;
}): JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const since = useRef<number | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;

    const tick = async (): Promise<void> => {
      try {
        const res = await api.getLogs(deploymentId, since.current);
        if (!live) return;
        if (res.lines.length > 0) {
          setLines((prev) => [...prev, ...res.lines]);
          if (res.nextSince) since.current = res.nextSince;
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    };

    void tick();
    if (isTerminal(status)) return;

    const timer = setInterval(() => void tick(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [deploymentId, status]);

  // Follow the tail as new lines arrive.
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines]);

  if (error) return <div className="banner">could not load logs: {error}</div>;

  if (lines.length === 0) {
    return (
      <div className="logs empty-logs">
        {isTerminal(status) ? 'no logs for this deployment' : 'waiting for the first log line…'}
      </div>
    );
  }

  return (
    <div className="logs" ref={box}>
      {lines.map((line, i) => (
        <div key={i} className={`logline ${line.level}`}>
          <span className="lt">{new Date(line.ts).toLocaleTimeString()}</span>
          <span className="lp">{line.phase}</span>
          <span className="lm">{line.msg}</span>
        </div>
      ))}
    </div>
  );
}
