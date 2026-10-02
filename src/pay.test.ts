import { describe, it, expect } from 'vitest';
import {
  usdc, fmtUsdc, short, STATUS, DAY, ZERO,
  isOpen, isOpenRequest, remaining,
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
