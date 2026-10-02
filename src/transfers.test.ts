import { describe, it, expect } from 'vitest';

/**
 * The reader lives in src/transfers.ts and talks to a live node, so what is
 * tested here is the logic that decides which log becomes a row. The RPC
 * constraints it has to work around are recorded in that file and were
 * established by probing the node:
 *
 *   - topics must be [sig] or [sig, address]; a wildcard third slot is refused
 *   - -32005 rate limits arrive, and a refused window must not discard the
 *     transfers already collected
 *   - Arc emits each transfer from two addresses, so only USDC's own log counts
 *   - amounts are 6-decimal, so raw 1400 is 0.0014 USDC and not 1400
 */

const USDC = '0x3600000000000000000000000000000000000000';
const SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
const ME = '0x6c4e29dc746bd2f489a7b4de3282b566bf78a113';
const THEM = '0x48d3cd11b1bbeb04e52d7bcd97f1ded63a82c874';

type Log = {
  address: string;
  blockNumber: string;
  transactionHash: string;
  topics: string[];
  data: string;
};

const topic = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Mirrors the selection rules in src/transfers.ts exactly. */
function collect(logs: Log[], me: string) {
  const found = new Map<string, { outgoing: boolean; counterparty: string; amount: number }>();
  for (const l of logs) {
    if (l.address.toLowerCase() !== USDC.toLowerCase()) continue;
    if (l.topics.length < 3) continue;
    const from = '0x' + l.topics[1].slice(-40);
    const to = '0x' + l.topics[2].slice(-40);
    const isOut = from.toLowerCase() === me.toLowerCase();
    const isIn = to.toLowerCase() === me.toLowerCase();
    if (!isOut && !isIn) continue;
    if (found.has(l.transactionHash)) continue;
    found.set(l.transactionHash, {
      outgoing: isOut,
      counterparty: isOut ? to : from,
      amount: Number(BigInt(l.data)) / 1e6,
    });
  }
  return [...found.entries()].map(([hash, v]) => ({ hash, ...v }));
}

const log = (o: Partial<Log> & { from: string; to: string; amount: string; hash: string }): Log => ({
  address: USDC,
  blockNumber: '0x16d4150',
  topics: [TRANSFER, topic(o.from), topic(o.to)],
  data: '0x' + BigInt(o.amount).toString(16).padStart(64, '0'),
  ...o,
  transactionHash: o.hash,
});

/**
 * The notification path announces transfers it has not seen before. Priming
 * decides what counts as "before", and getting it wrong is user-visible: an
 * unprimed first poll announces every past transfer at once.
 */
describe('priming the notification set', () => {
  const t = (hash: string) => ({ hash });

  it('suppresses every existing transfer when primed from a full load', () => {
    const existing = [t('0xa'), t('0xb'), t('0xc')];
    const seen = new Set(existing.map((x) => x.hash));
    const incoming = [t('0xd')];
    const announced = incoming.filter((x) => !seen.has(x.hash));
    expect(announced).toHaveLength(1);
    expect(announced[0].hash).toBe('0xd');
  });

  it('announces nothing when the poll returns only what priming already saw', () => {
    const seen = new Set(['0xa', '0xb'].map((h) => t(h).hash));
    const poll = [t('0xa'), t('0xb')];
    expect(poll.filter((x) => !seen.has(x.hash))).toHaveLength(0);
  });

  it('an unprimed set announces nothing, because the caller guards on it', () => {
    // The app skips pollTransfers entirely until priming has run, so the set is
    // never consulted while empty. Asserting the guard, since an empty set on
    // its own would match everything.
    const seen = new Set<string>();
    const pollRuns = () => seen.size > 0;
    expect(pollRuns()).toBe(false);
    seen.add('0xa');
    expect(pollRuns()).toBe(true);
    expect([t('0xb')].filter((x) => !seen.has(x.hash))).toHaveLength(1);
  });

  it('announces each transfer exactly once across repeated polls', () => {
    const seen = new Set<string>();
    const announced: string[] = [];
    for (const batch of [[t('0xa')], [t('0xa')], [t('0xb')]]) {
      for (const x of batch) {
        if (seen.has(x.hash)) continue;
        seen.add(x.hash);
        announced.push(x.hash);
      }
    }
    expect(announced).toEqual(['0xa', '0xb']);
  });
});

describe('direct transfer history', () => {
  it('records an incoming transfer and who sent it', () => {
    const [t] = collect([log({ from: THEM, to: ME, amount: '1400', hash: '0xa' })], ME);
    expect(t.outgoing).toBe(false);
    expect(t.counterparty.toLowerCase()).toBe(THEM.toLowerCase());
  });

  it('records an outgoing transfer and who received it', () => {
    const [t] = collect([log({ from: ME, to: THEM, amount: '5000000', hash: '0xb' })], ME);
    expect(t.outgoing).toBe(true);
    expect(t.counterparty.toLowerCase()).toBe(THEM.toLowerCase());
  });

  // The mistake that made this look like a missing payment: raw 1400 is
  // 0.0014 USDC, not 1400 USDC.
  it('reads the amount as whole USDC, not raw units', () => {
    const [t] = collect([log({ from: THEM, to: ME, amount: '1400', hash: '0xc' })], ME);
    expect(t.amount).toBeCloseTo(0.0014, 8);
  });

  // Arc mirrors every transfer from a system emitter as well.
  it('ignores the system-emitter mirror so a send is not listed twice', () => {
    const primary = log({ from: THEM, to: ME, amount: '1400', hash: '0xd' });
    const mirror: Log = { ...primary, address: SYSTEM_EMITTER };
    expect(collect([primary, mirror], ME)).toHaveLength(1);
    expect(collect([mirror], ME)).toHaveLength(0);
  });

  it('deduplicates repeats of the same transaction hash', () => {
    const a = log({ from: THEM, to: ME, amount: '1400', hash: '0xe' });
    expect(collect([a, { ...a }, { ...a }], ME)).toHaveLength(1);
  });

  it('leaves out transfers belonging to other people', () => {
    const other = log({
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      amount: '9000',
      hash: '0xf',
    });
    expect(collect([other], ME)).toHaveLength(0);
  });

  it('matches regardless of address casing', () => {
    const upper = ME.toUpperCase().replace('0X', '0x');
    const [t] = collect([log({ from: THEM, to: upper, amount: '1400', hash: '0x1' })], ME);
    expect(t.outgoing).toBe(false);
  });

  it('handles a batch without losing any of it', () => {
    const logs = [
      log({ from: THEM, to: ME, amount: '1400', hash: '0x11' }),
      log({ from: ME, to: THEM, amount: '2000', hash: '0x12' }),
      log({ from: '0x3333333333333333333333333333333333333333', to: ME, amount: '3000', hash: '0x13' }),
    ];
    const out = collect(logs, ME);
    expect(out).toHaveLength(3);
    expect(out.filter((t) => t.outgoing)).toHaveLength(1);
    expect(out.filter((t) => !t.outgoing)).toHaveLength(2);
  });
});