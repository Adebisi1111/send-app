import { describe, it, expect } from 'vitest';
import { parseIntent, ParseError } from './intent';

const NOW = 1_700_000_000;
const PROVIDER = '0xA08a79B4f6e5a7322E0df73Ab514006Dd3710B9D';

describe('parseIntent', () => {
  it('parses the canonical sentence', () => {
    const r = parseIntent(`pay 5 USDC to ${PROVIDER} for the landing page`, NOW);
    expect(r.provider).toBe(PROVIDER);
    expect(r.amountUsdc).toBe(5);
    expect(r.amountUnits).toBe(5_000_000n);
    expect(r.description).toBe('the landing page');
  });

  it('parses $ notation', () => {
    const r = parseIntent(`pay $12.50 to ${PROVIDER}`, NOW);
    expect(r.amountUsdc).toBe(12.5);
    expect(r.amountUnits).toBe(12_500_000n);
  });

  it('parses decimals correctly to 6dp units', () => {
    const r = parseIntent(`pay 0.25 USDC to ${PROVIDER}`, NOW);
    expect(r.amountUnits).toBe(250_000n);
  });

  it('parses expiry in hours', () => {
    const r = parseIntent(`pay 5 USDC to ${PROVIDER} in 2 hours`, NOW);
    expect(r.expiresAt).toBe(NOW + 7200);
    expect(r.expiryLabel).toBe('in 2 hours');
  });

  it('parses expiry in days', () => {
    const r = parseIntent(`pay 5 USDC to ${PROVIDER} in 3 days`, NOW);
    expect(r.expiresAt).toBe(NOW + 259_200);
  });

  it('parses singular hour without trailing s', () => {
    const r = parseIntent(`pay 5 USDC to ${PROVIDER} in 1 hour`, NOW);
    expect(r.expiresAt).toBe(NOW + 3600);
  });

  it('defaults expiry to 24h when unspecified', () => {
    const r = parseIntent(`pay 5 USDC to ${PROVIDER}`, NOW);
    expect(r.expiresAt).toBe(NOW + 86400);
  });

  it('rejects a missing address', () => {
    expect(() => parseIntent('pay 5 USDC for the landing page', NOW)).toThrow(ParseError);
  });

  it('rejects a missing amount', () => {
    expect(() => parseIntent(`pay ${PROVIDER}`, NOW)).toThrow(ParseError);
  });

  it('rejects the Arc-blocklisted burn address', () => {
    const burn = '0x000000000000000000000000000000000000dEaD';
    expect(() => parseIntent(`pay 5 USDC to ${burn}`, NOW)).toThrow(/blocked/i);
  });

  it('rejects the zero address', () => {
    const zero = '0x0000000000000000000000000000000000000000';
    expect(() => parseIntent(`pay 5 USDC to ${zero}`, NOW)).toThrow(ParseError);
  });

  it('rejects empty input', () => {
    expect(() => parseIntent('   ', NOW)).toThrow(ParseError);
  });

  it('never produces a zero amount', () => {
    const r = parseIntent(`pay 0.001 USDC to ${PROVIDER}`, NOW);
    expect(r.amountUnits).toBe(1_000n);
    expect(r.amountUnits).toBeGreaterThan(0n);
  });

  it('does not leak the address into the description', () => {
    const r = parseIntent(`pay 5 USDC to ${PROVIDER} for the landing page`, NOW);
    expect(r.description).not.toContain('0x');
  });

  it('does not leak the amount into the description', () => {
    const r = parseIntent(`pay 5 USDC to ${PROVIDER} for the landing page`, NOW);
    expect(r.description).not.toMatch(/\b5\b/);
  });

  it('handles a full realistic sentence', () => {
    const r = parseIntent(
      `please create a new escrow job to pay ${PROVIDER} 40 USDC for the logo design in 5 days`,
      NOW,
    );
    expect(r.provider).toBe(PROVIDER);
    expect(r.amountUsdc).toBe(40);
    expect(r.expiresAt).toBe(NOW + 5 * 86400);
    expect(r.description.toLowerCase()).toContain('logo design');
  });
});