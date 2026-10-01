import { describe, it, expect } from 'vitest';
import { parseSplit, splitUnits, ParseError } from './intent';

const NOW = 1_700_000_000;
const A = '0xA08a79B4f6e5a7322E0df73Ab514006Dd3710B9D';
const B = '0x47D19387fB2D71A3107e4E8748E533AF944E84B4';
const C = '0x3beca10149599dec3ec5f857b9f9523a4119541c';

describe('parseSplit', () => {
  it('splits evenly between the listed addresses', () => {
    const r = parseSplit(`split 100 USDC between ${A} and ${B}`, NOW);
    expect(r.totalUsdc).toBe(100);
    expect(r.addresses).toEqual([A, B]);
    expect(r.shares).toBe(2);
    expect(r.perPersonUsdc).toBe(50);
  });

  it('honours an explicit "N ways" count', () => {
    const r = parseSplit(`split 120 USDC 3 ways between ${A}, ${B} and ${C}`, NOW);
    expect(r.shares).toBe(3);
  });

  it('parts always sum back to the total', () => {
    const total = BigInt(100_000_000); // 100 USDC
    const parts = splitUnits(total, 3);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
  });

  it('handles a total that does not divide evenly', () => {
    // 10 USDC split 3 ways = 3.3333... — remainder must not vanish
    const total = BigInt(10_000_000);
    const parts = splitUnits(total, 3);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
    expect(parts[0]).toBe(3_333_334n);
    expect(parts[1]).toBe(3_333_333n);
    expect(parts[2]).toBe(3_333_333n);
  });

  it('produces integer shares with no fractional dust', () => {
    const parts = splitUnits(BigInt(100_000_000), 7);
    expect(parts.every(p => typeof p === 'bigint')).toBe(true);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(BigInt(100_000_000));
  });

  it('rejects a split with no addresses', () => {
    expect(() => parseSplit('split 100 USDC between everyone', NOW)).toThrow(ParseError);
  });

  it('rejects a split with no amount', () => {
    try {
      parseSplit(`split the bill between ${A} and ${B}`, NOW);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).missing).toContain('amount');
    }
  });

  it('rejects a non-split sentence', () => {
    expect(() => parseSplit(`pay 5 USDC to ${A}`, NOW)).toThrow(ParseError);
  });

  it('skips blocklisted addresses', () => {
    const burn = '0x000000000000000000000000000000000000dEaD';
    const r = parseSplit(`split 100 USDC between ${A} and ${burn}`, NOW);
    expect(r.addresses).toEqual([A]);
  });

  it('parses expiry on a split', () => {
    const r = parseSplit(`split 100 USDC between ${A} and ${B} in 2 hours`, NOW);
    expect(r.expiresAt).toBe(NOW + 7200);
  });
});