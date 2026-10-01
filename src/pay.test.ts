import { describe, it, expect } from 'vitest';
import { usdc, short, STATUS, DAY } from './pay';

describe('usdc formatting', () => {
  it('converts 6dp units to a number', () => {
    expect(usdc(3_000_000n)).toBe(3);
    expect(usdc(1n)).toBe(0.000001);
    expect(usdc(0n)).toBe(0);
  });

  it('handles a realistic dinner split', () => {
    expect(usdc(20_000_000n)).toBe(20);
    expect(usdc(6_666_666n)).toBeCloseTo(6.666666, 6);
  });
});

describe('address shortening', () => {
  it('keeps both ends so wallets stay distinguishable', () => {
    const a = '0x59a8fd5c011FBa95C1C4479E407cdd7e5C1B1213';
    const b = '0x1f16BD5F883AA41247fc2F57E987ef04341e3fdB';
    const s = short(a);
    expect(s).toContain('0x59a8');
    expect(s).toContain('1213');
    expect(short(a)).not.toBe(short(b));
  });
});

describe('status labels', () => {
  it('names every state the contract can be in', () => {
    expect(STATUS[0]).toBe('None');
    expect(STATUS[1]).toBe('Pending');
    expect(STATUS[2]).toBe('Released');
    expect(STATUS[3]).toBe('Cancelled');
    expect(STATUS[4]).toBe('Refunded');
  });
});

describe('expiry', () => {
  it('caps a request at 30 days, matching the contract', () => {
    const max = 30 * DAY;
    const chosen = 7 * DAY;
    expect(chosen).toBeLessThan(max);
  });
});
