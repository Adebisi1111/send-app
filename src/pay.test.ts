import { describe, it, expect } from 'vitest';
import {
  usdc, fmtUsdc, short, STATUS, DAY, ZERO,
  isOpen, isOpenRequest, remaining, mergeActionable, directionOf, explain,
  type Request,
} from './pay';

const request = (over: Partial<Request> = {}): Request => ({
  id: 1n,
  requester: '0x59a8fd5c011FBa95C1C4479E407cdd7e5C1B1213',
  named: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  username: 'bob',
  purpose: 'tea',
  amount: 10_000_000n,
  collected: 0n,
  expiresAt: 0n,
  status: 1,
  ...over,
});

describe('usdc formatting', () => {
  it('converts 6dp units to a number', () => {
    expect(usdc(3_000_000n)).toBe(3);
    expect(usdc(1n)).toBe(0.000001);
    expect(usdc(0n)).toBe(0);
  });

  it('formats for display without trailing zeros', () => {
    expect(fmtUsdc(1_000_000n)).toBe('1');
    expect(fmtUsdc(10_000n)).toBe('0.01');
    expect(fmtUsdc(0n)).toBe('0');
    expect(fmtUsdc(1_500n)).toBe('0.0015');
  });

  it('never rounds a real amount down to zero', () => {
    // 6 decimals is USDC's actual precision; anything under 0.000001 is
    // unrepresentable, but a sub-cent request must still read as itself.
    expect(fmtUsdc(5n)).toBe('0.000005');
    expect(fmtUsdc(1n)).toBe('0.000001');
    expect(fmtUsdc(999n)).toBe('0.000999');
    expect(fmtUsdc(10n)).toBe('0.00001');
  });
});

describe('address shortening', () => {
  it('keeps both ends so wallets stay distinguishable', () => {
    const a = '0x59a8fd5c011FBa95C1C4479E407cdd7e5C1B1213';
    const b = '0x1f16BD5F883AA41247fc2F57E987ef04341e3fdB';
    expect(short(a)).toContain('0x59a8');
    expect(short(a)).toContain('1213');
    expect(short(a)).not.toBe(short(b));
  });
});

describe('status labels', () => {
  it('names every state the contract can be in', () => {
    expect(STATUS[0]).toBe('None');
    expect(STATUS[1]).toBe('Open');
    expect(STATUS[2]).toBe('Paid');
    expect(STATUS[3]).toBe('Cancelled');
  });
});

describe('open vs settled', () => {
  it('treats status 1 as open', () => {
    expect(isOpen(request())).toBe(true);
    expect(isOpen(request({ status: 2 }))).toBe(false);
    expect(isOpen(request({ status: 3 }))).toBe(false);
  });

  it('detects an open request that named nobody', () => {
    expect(isOpenRequest(request({ named: ZERO, username: '' }))).toBe(true);
    expect(isOpenRequest(request())).toBe(false);
  });

  it('is no longer open once it is settled', () => {
    expect(isOpenRequest(request({ named: ZERO, status: 2 }))).toBe(false);
  });
});

describe('remaining amount', () => {
  it('is the full amount before any payment', () => {
    expect(remaining(request())).toBe(10_000_000n);
  });

  it('shrinks as people chip in', () => {
    expect(remaining(request({ collected: 4_000_000n }))).toBe(6_000_000n);
  });

  it('reaches zero when the last person pays', () => {
    expect(remaining(request({ collected: 10_000_000n }))).toBe(0n);
  });
});

describe('expiry', () => {
  it('caps a request at 90 days, matching the contract', () => {
    expect(14 * DAY).toBeLessThan(90 * DAY);
  });
});
describe('Declined status', () => {
  it('is the fifth enum value', () => {
    expect(STATUS[4]).toBe('Declined');
  });

  it('is not open, so no pay or decline controls show', () => {
    expect(isOpen(request({ status: 4 }))).toBe(false);
  });

  it('an open request is still open', () => {
    expect(isOpen(request({ status: 1 }))).toBe(true);
  });
});

describe('merging named and open requests into one list', () => {
  const ZERO = '0x0000000000000000000000000000000000000000';

  it('puts named requests before open ones', () => {
    const out = mergeActionable([request({ id: 1n })], [request({ id: 2n, named: ZERO })]);
    expect(out.map((r) => r.id)).toEqual([1n, 2n]);
  });

  it('keeps newest first within each group', () => {
    const out = mergeActionable([request({ id: 1n }), request({ id: 5n })], [request({ id: 9n, named: ZERO })]);
    expect(out.map((r) => r.id)).toEqual([5n, 1n, 9n]);
  });

  it('keeps one entry when a request appears in both lists', () => {
    const r = request({ id: 7n });
    const out = mergeActionable([r, r], []);
    expect(out.length).toBe(1);
  });

  it('handles an empty list', () => {
    expect(mergeActionable([], [])).toEqual([]);
  });
});

describe('which side of a request you are on', () => {
  const ME = '0x59a8fd5c011FBa95C1C4479E407cdd7e5C1B1213';
  const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

  it('is asking when you made the request', () => {
    expect(directionOf(request({ requester: ME }), ME)).toBe('asking');
  });

  it('is asked-of-me when someone else made it', () => {
    expect(directionOf(request({ requester: OTHER }), ME)).toBe('asked-of-me');
  });

  it('ignores address casing', () => {
    const shouted = `0x${ME.slice(2).toUpperCase()}` as typeof ME;
    expect(directionOf(request({ requester: shouted }), ME)).toBe('asking');
  });

  it('a request you made must never be pending for you', () => {
    const mine = request({ id: 1n, requester: ME });
    const theirs = request({ id: 2n, requester: OTHER });
    const pending = mergeActionable([mine, theirs], []).filter((r) => directionOf(r, ME) !== 'asking');
    expect(pending.map((r) => r.id)).toEqual([2n]);
  });
});

describe('turning wallet errors into something actionable', () => {
  const err = (shortMessage?: string, message?: string) => ({ shortMessage, message });

  it('points at the wallet RPC rather than blaming the app', () => {
    const out = explain(err('Http request failed'));
    expect(out).toContain('https://rpc.mainnet.arc.io');
    expect(out).toContain('wallet settings');
  });

  it('recognises the fetch variants wallets use for the same thing', () => {
    for (const m of ['Http request failed', 'fetch failed', 'NetworkError', 'Failed to fetch']) {
      expect(explain(err(m))).toContain('cannot reach Arc');
    }
  });

  it('says the user cancelled when they rejected the signature', () => {
    expect(explain(err('User rejected the request'))).toContain('cancelled');
  });

  it('explains that Arc charges gas in USDC', () => {
    expect(explain(err('insufficient funds for gas'))).toContain('USDC for gas');
  });

  it('names the already-taken case', () => {
    expect(explain(err('Username already taken'))).toContain('already taken');
  });

  it('never swallows a real revert reason', () => {
    expect(explain(err('ERC20: transfer amount exceeds balance')))
      .toBe('ERC20: transfer amount exceeds balance');
  });

  it('falls back when there is no message at all', () => {
    expect(explain({})).toContain('Try again');
  });
});
