import { describe, expect, it } from 'vitest';
import { priorRoundDigest, type DigestRound, type DigestStep } from './application/orchestration/digest.js';

function step(partial: Partial<DigestStep> & Pick<DigestStep, 'subtaskTitle' | 'status'>): DigestStep {
  return { kind: 'develop', attempt: 1, continueCount: 0, error: null, review: null, problems: [], ...partial };
}

function round(partial: Partial<DigestRound> & Pick<DigestRound, 'round'>): DigestRound {
  return { status: 'rejected', finalComment: null, rejectionReason: null, acceptanceNote: null, steps: [], ...partial };
}

describe('priorRoundDigest', () => {
  it('returns empty when there is nothing to carry forward', () => {
    expect(priorRoundDigest([])).toBe('');
    expect(priorRoundDigest([round({
      round: 1,
      status: 'accepted',
      steps: [step({ subtaskTitle: 'Login', status: 'succeeded' })],
    })])).toBe('');
  });

  it('keeps the two newest rounds, newest first', () => {
    const text = priorRoundDigest([
      round({ round: 1, rejectionReason: 'OLD' }),
      round({ round: 3, rejectionReason: 'NEW' }),
      round({ round: 2, rejectionReason: 'MID' }),
    ]);
    expect(text.indexOf('NEW')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('NEW')).toBeLessThan(text.indexOf('MID'));
    expect(text).not.toContain('OLD');
  });

  it('keeps only failing or reworked steps, and filters by subtask while keeping the rejection and final comment', () => {
    const text = priorRoundDigest([round({
      round: 2,
      rejectionReason: 'USER_REJECT',
      finalComment: 'FINAL_WORD',
      acceptanceNote: 'ACCEPT_NOTE',
      steps: [
        step({ subtaskTitle: 'Login', status: 'needs_user', error: 'login broke' }),
        step({ subtaskTitle: 'Billing', status: 'failed', error: 'billing broke' }),
        step({ subtaskTitle: 'Login', status: 'succeeded', attempt: 1, continueCount: 0, error: 'clean login' }),
        step({ subtaskTitle: 'Login', status: 'succeeded', attempt: 2, error: 'retried login' }),
        step({ subtaskTitle: 'Docs', status: 'succeeded', continueCount: 1, error: 'continued docs' }),
      ],
    })]);
    expect(text).toContain('login broke');
    expect(text).toContain('retried login');
    expect(text).not.toContain('clean login');
    expect(text).toContain('ACCEPT_NOTE');
    const filtered = priorRoundDigest([round({
      round: 2,
      rejectionReason: 'USER_REJECT',
      finalComment: 'FINAL_WORD',
      acceptanceNote: 'ACCEPT_NOTE',
      steps: [
        step({ subtaskTitle: 'Login', status: 'needs_user', error: 'login broke' }),
        step({ subtaskTitle: 'Billing', status: 'failed', error: 'billing broke' }),
      ],
    })], { subtaskTitle: 'Login' });
    expect(filtered).toContain('login broke');
    expect(filtered).toContain('USER_REJECT');
    expect(filtered).toContain('FINAL_WORD');
    expect(filtered).not.toContain('billing broke');
    expect(filtered).not.toContain('ACCEPT_NOTE');
  });

  it('clips each field, each round, and the total', () => {
    const error = 'e'.repeat(600);
    const clipped = priorRoundDigest([round({
      round: 1,
      steps: [step({ subtaskTitle: 'A', status: 'needs_user', error })],
    })]);
    expect(clipped).toContain('e'.repeat(500));
    expect(clipped).not.toContain('e'.repeat(501));

    const fat = (roundNo: number, reason: string): DigestRound => round({
      round: roundNo,
      rejectionReason: reason,
      finalComment: 'f'.repeat(800),
      steps: Array.from({ length: 12 }, (_, index) => step({
        subtaskTitle: `S${index}`,
        status: 'failed',
        attempt: 2,
        continueCount: 1,
        error: 'e'.repeat(400),
        review: 'r'.repeat(400),
        problems: ['p'.repeat(400), 'q'.repeat(400), 's'.repeat(400), 'drop-me'],
      })),
    });
    const one = priorRoundDigest([fat(4, 'KEEP_REASON')]);
    expect(one.length).toBeLessThanOrEqual(2000);
    expect(one).toContain('KEEP_REASON');
    expect(one).toContain('f'.repeat(500));
    expect(one).not.toContain('f'.repeat(501));
    expect(one).not.toContain('drop-me');

    const both = priorRoundDigest([fat(8, 'OLDER_REASON'), fat(9, 'NEW_REASON')]);
    expect(both.length).toBeLessThanOrEqual(4000);
    expect(both.split('\n').every((part) => part.length <= 2000)).toBe(true);
    expect(both.startsWith('{"round":9')).toBe(true);
    expect(both).toContain('NEW_REASON');
  });
});
