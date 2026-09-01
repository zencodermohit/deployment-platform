/**
 * Metrics via CloudWatch Embedded Metric Format.
 *
 * EMF means writing a specially-shaped JSON line to stdout; CloudWatch extracts
 * the metrics from the log stream. No PutMetricData call, so no extra API
 * request, no extra latency on the request path, and no IAM permission needed.
 * At this volume that is the difference between free and not.
 *
 * The line is also a perfectly readable log entry, so the same record serves
 * both purposes — you can see the dimension values right next to the metric.
 */

export const METRIC_NAMESPACE = 'DeploymentPlatform';

export type Unit =
  | 'Count'
  | 'Milliseconds'
  | 'Seconds'
  | 'Bytes'
  | 'Percent'
  | 'None';

export interface MetricInput {
  name: string;
  value: number;
  unit?: Unit;
}

export interface EmitOptions {
  metrics: MetricInput[];
  /**
   * Dimensions are what you can group and alarm by — but each distinct
   * combination is a separate CloudWatch metric with its own cost, so these
   * must be LOW cardinality. Never a deployment id or a user id.
   */
  dimensions?: Record<string, string>;
  /** Extra context. Searchable in logs, but not part of any metric. */
  properties?: Record<string, unknown>;
  write?: (line: string) => void;
}

export function emitMetrics(options: EmitOptions): void {
  const { metrics, dimensions = {}, properties = {}, write } = options;
  if (metrics.length === 0) return;

  const dimensionNames = Object.keys(dimensions);

  const record: Record<string, unknown> = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          // A single dimension set. Multiple sets multiply the metric count,
          // and therefore the bill, faster than people expect.
          Dimensions: dimensionNames.length > 0 ? [dimensionNames] : [[]],
          Metrics: metrics.map((metric) => ({
            Name: metric.name,
            Unit: metric.unit ?? 'Count',
          })),
        },
      ],
    },
    ...dimensions,
    ...properties,
  };

  for (const metric of metrics) {
    record[metric.name] = metric.value;
  }

  const line = JSON.stringify(record);
  if (write) write(line);
  else console.log(line);
}

/** Metric names, in one place so the dashboard and the code cannot drift. */
export const METRICS = {
  deploymentOutcome: 'DeploymentOutcome',
  buildDuration: 'BuildDurationMs',
  dispatchLatency: 'DispatchLatencyMs',
  provisioningLatency: 'ProvisioningLatencyMs',
  artifactBytes: 'ArtifactBytes',
  artifactFiles: 'ArtifactFiles',
  sweptDeployments: 'SweptDeployments',
  reconciledFailures: 'ReconciledFailures',
  quotaRejections: 'QuotaRejections',
} as const;
