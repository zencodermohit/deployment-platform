import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  allowedPredecessors,
  assertTransition,
  canTransition,
  computeDeadline,
  InvalidTransitionError,
  isTerminal,
  type DeploymentStatus,
} from '@platform/core';

/**
 * These tests are driven from the transition table itself rather than from a
 * hand-written list of cases. Adding a transition to the table automatically
 * widens what is allowed; forgetting to think about it does not silently pass.
 */

const ALL = DEPLOYMENT_STATUSES;

function isAllowed(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to);
}

describe('state machine — the happy path', () => {
  it('walks QUEUED to DEPLOYED one step at a time', () => {
    const path: DeploymentStatus[] = [
      'QUEUED',
      'PROVISIONING',
      'BUILDING',
      'UPLOADING',
      'DEPLOYED',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it('never allows skipping a step', () => {
    expect(canTransition('QUEUED', 'BUILDING')).toBe(false);
    expect(canTransition('QUEUED', 'DEPLOYED')).toBe(false);
    expect(canTransition('PROVISIONING', 'UPLOADING')).toBe(false);
    expect(canTransition('BUILDING', 'DEPLOYED')).toBe(false);
  });

  it('never allows going backwards', () => {
    expect(canTransition('BUILDING', 'QUEUED')).toBe(false);
    expect(canTransition('UPLOADING', 'BUILDING')).toBe(false);
    expect(canTransition('DEPLOYED', 'UPLOADING')).toBe(false);
  });
});

describe('state machine — exhaustive matrix', () => {
  // Every one of the 49 pairs is checked against the table. This is what stops
  // a stray transition being added without anyone noticing.
  it.each(ALL.flatMap((from) => ALL.map((to) => [from, to] as const)))(
    '%s -> %s matches the table',
    (from, to) => {
      expect(canTransition(from, to)).toBe(isAllowed(from, to));
    },
  );

  it('never allows a self-transition', () => {
    for (const status of ALL) {
      expect(canTransition(status, status), `${status} -> ${status}`).toBe(false);
    }
  });

  it('lets no terminal state transition anywhere', () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const to of ALL) {
        expect(canTransition(terminal, to), `${terminal} -> ${to}`).toBe(false);
      }
    }
  });

  it('lets every non-terminal state fail', () => {
    for (const status of ALL) {
      if (isTerminal(status)) continue;
      expect(canTransition(status, 'FAILED'), `${status} -> FAILED`).toBe(true);
    }
  });
});

describe('state machine — actors', () => {
  it('reserves the claim for the dispatcher', () => {
    expect(canTransition('QUEUED', 'PROVISIONING', 'dispatcher')).toBe(true);
    expect(canTransition('QUEUED', 'PROVISIONING', 'container')).toBe(false);
    expect(canTransition('QUEUED', 'PROVISIONING', 'api')).toBe(false);
  });

  it('lets only the container report build progress', () => {
    expect(canTransition('BUILDING', 'UPLOADING', 'container')).toBe(true);
    expect(canTransition('BUILDING', 'UPLOADING', 'api')).toBe(false);
    expect(canTransition('BUILDING', 'UPLOADING', 'dispatcher')).toBe(false);
  });

  it('lets the reconciler and sweeper fail a build, but not advance one', () => {
    expect(canTransition('BUILDING', 'FAILED', 'reconciler')).toBe(true);
    expect(canTransition('BUILDING', 'FAILED', 'sweeper')).toBe(true);
    expect(canTransition('BUILDING', 'UPLOADING', 'reconciler')).toBe(false);
  });

  it('only allows cancelling before a container is running', () => {
    expect(canTransition('QUEUED', 'CANCELLED', 'api')).toBe(true);
    expect(canTransition('PROVISIONING', 'CANCELLED', 'api')).toBe(true);
    // Once building, there is nothing useful to cancel — it finishes or times out.
    expect(canTransition('BUILDING', 'CANCELLED', 'api')).toBe(false);
    expect(canTransition('UPLOADING', 'CANCELLED', 'api')).toBe(false);
  });
});

describe('allowedPredecessors — drives the ConditionExpression', () => {
  it('lists exactly the states a move may come from', () => {
    expect(allowedPredecessors('PROVISIONING').sort()).toEqual(['QUEUED']);
    expect(allowedPredecessors('DEPLOYED').sort()).toEqual(['UPLOADING']);
    expect(allowedPredecessors('FAILED').sort()).toEqual([
      'BUILDING',
      'PROVISIONING',
      'QUEUED',
      'UPLOADING',
    ]);
    expect(allowedPredecessors('CANCELLED').sort()).toEqual(['PROVISIONING', 'QUEUED']);
  });

  it('narrows by actor', () => {
    expect(allowedPredecessors('FAILED', 'container').length).toBeGreaterThan(0);
    expect(allowedPredecessors('PROVISIONING', 'container')).toEqual([]);
  });

  it('returns nothing for a state nothing can reach', () => {
    expect(allowedPredecessors('QUEUED')).toEqual([]);
  });
});

describe('assertTransition', () => {
  it('passes a legal move silently', () => {
    expect(() => assertTransition('QUEUED', 'PROVISIONING', 'dispatcher')).not.toThrow();
  });

  it('throws a typed error naming both states', () => {
    try {
      assertTransition('DEPLOYED', 'BUILDING');
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      const err = e as InvalidTransitionError;
      expect(err.from).toBe('DEPLOYED');
      expect(err.to).toBe('BUILDING');
      expect(err.message).toMatch(/cannot move/);
    }
  });

  it('names the actor when one was given', () => {
    try {
      assertTransition('QUEUED', 'PROVISIONING', 'container');
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as InvalidTransitionError).message).toMatch(/container may not/);
    }
  });
});

describe('computeDeadline', () => {
  it('adds the build timeout plus slack for cold start', () => {
    const created = '2026-09-01T10:00:00.000Z';
    // 600s timeout + 120s slack = 12 minutes
    expect(computeDeadline(created, 600)).toBe('2026-09-01T10:12:00.000Z');
  });

  it('always lands after creation', () => {
    for (const timeout of [1, 60, 600, 3600]) {
      const created = new Date().toISOString();
      expect(new Date(computeDeadline(created, timeout)).getTime()).toBeGreaterThan(
        new Date(created).getTime(),
      );
    }
  });
});
