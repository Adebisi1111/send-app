import { useState } from 'react';
import { useAccount, useConnect, useWriteContract } from 'wagmi';
import { createPublicClient, http, zeroAddress } from 'viem';
import { waitForTransactionReceipt } from 'viem/actions';
import { arcMainnet } from './chain';
import {
  USDC, REGISTRY, REQUESTS, REGISTRY_ABI, REQUEST_ABI, ERC20_ABI,
  STATUS, usdc, short, DAY, type Request,
} from './pay';

const client = createPublicClient({ chain: arcMainnet, transport: http() });

// ---------------------------------------------------------------- helpers

async function readRequest(id: bigint): Promise<Request | null> {
  try {
    const r = await client.readContract({
      address: REQUESTS, abi: REQUEST_ABI, functionName: 'getRequest', args: [id],
    });
    return r as unknown as Request;
  } catch {
    return null;
  }
}

async function readInbox(who: `0x${string}`): Promise<bigint[]> {
  try {
    const r = await client.readContract({ address: REQUESTS, abi: REQUEST_ABI, functionName: 'inbox', args: [who] });
    return r as unknown as bigint[];
  } catch {
    return [];
  }
}

async function resolveName(u: string): Promise<`0x${string}` | null> {
  const who = await client.readContract({
    address: REGISTRY, abi: REGISTRY_ABI, functionName: 'resolve', args: [u],
  });
  return who as unknown as `0x${string}`;
}

// ---------------------------------------------------------------- styles

const card: React.CSSProperties = {
  background: '#0f141c', border: '1px solid #1f2733', borderRadius: 12, padding: 18,
};
const input: React.CSSProperties = {
  width: '100%', padding: '12px 14px', borderRadius: 9, border: '1px solid #232c3a',
  background: '#0a0e14', color: '#e6e9ef', fontSize: 15, marginBottom: 10,
};
const btn = (bg: string, fg = '#04150f'): React.CSSProperties => ({
  padding: '12px 18px', borderRadius: 9, border: 'none', background: bg, color: fg,
  fontWeight: 650, cursor: 'pointer', fontSize: 14,
});
const label: React.CSSProperties = {
  fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.7,
  color: '#6d7787', marginBottom: 7, fontWeight: 600,
};

// ---------------------------------------------------------------- app

export default function Pay() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { writeContractAsync } = useWriteContract();

  const [tab, setTab] = useState<'ask' | 'send' | 'inbox'>('ask');

  // claim a username
  const [name, setName] = useState('');
  const [nameState, setNameState] = useState<{ taken?: boolean; mine?: boolean; done?: boolean }>({});

  // ask for money
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [auto, setAuto] = useState(true);

  // send
  const [lookup, setLookup] = useState<`0x${string}` | null>(null);
  const [sendTo, setSendTo] = useState('');
  const [sendAmt, setSendAmt] = useState('');

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [inbox, setInbox] = useState<Request[]>([]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label); setErr(null); setNote(null);
    try {
      const msg = await fn();
      setNote(msg);
      return true;
    } catch (e: any) {
      setErr(`${e?.shortMessage ?? e?.message ?? 'failed'}`);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const claim = () =>
    run('Claiming…', async () => {
      if (!address) throw new Error('Connect a wallet first');
      const taken = await client.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'isTaken', args: [name.toLowerCase()] });
      if (taken) { setNameState({ taken: true }); throw new Error(`@${name} is already taken`); }
      const h = await writeContractAsync({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'register', args: [name.toLowerCase()] });
      await waitForTransactionReceipt(client, { hash: h });
      setNameState({ done: true });
      return `You are now @${name.toLowerCase()}`;
    });

  const ask = () =>
    run('Creating request…', async () => {
      if (!address) throw new Error('Connect a wallet first');
      const units = BigInt(Math.round(parseFloat(amount) * 1e6));
      if (!(units > 0n)) throw new Error('Enter an amount');
      if (!purpose.trim()) throw new Error('Say what it is for');

      const recipient = await resolveName(to.replace(/^@/, '').toLowerCase());
      if (!recipient || recipient === zeroAddress) throw new Error(`No one is @${to}`);

      const approveHash = await writeContractAsync({
        address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [REQUESTS, units],
      });
      await waitForTransactionReceipt(client, { hash: approveHash });
      const h = await writeContractAsync({
        address: REQUESTS, abi: REQUEST_ABI, functionName: 'requestFor',
        args: [to.replace(/^@/, '').toLowerCase(), purpose.trim(), units, BigInt(Math.floor(Date.now() / 1000) + 7 * DAY), auto],
      });
      await waitForTransactionReceipt(client, { hash: h });
      return `Requested ${amount} USDC from @${to.replace(/^@/, '').toLowerCase()}`;
    });

  const send = () =>
    run('Sending…', async () => {
      if (!lookup) throw new Error('Look up a username first');
      const units = BigInt(Math.round(parseFloat(sendAmt) * 1e6));
      const h = await writeContractAsync({
        address: USDC, abi: ['function transfer(address,uint256)'] as any,
        functionName: 'transfer', args: [lookup, units],
      });
      await waitForTransactionReceipt(client, { hash: h });
      return `Sent ${sendAmt} USDC to @${sendTo.replace(/^@/, '').toLowerCase()}`;
    });

  const find = async () => {
    const who = await resolveName(sendTo.replace(/^@/, '').toLowerCase());
    setLookup(!who || who === zeroAddress ? null : who);
  };

  const loadInbox = async () => {
    if (!address) return;
    setBusy('Loading…');
    try {
      const ids = await readInbox(address);
      const rs = await Promise.all(ids.map(readRequest));
      setInbox(rs.filter((r): r is Request => !!r).reverse());
    } finally { setBusy(null); }
  };

  const release = (id: bigint) =>
    run('Releasing…', async () => {
      const h = await writeContractAsync({ address: REQUESTS, abi: REQUEST_ABI, functionName: 'release', args: [id] });
      await waitForTransactionReceipt(client, { hash: h });
      await loadInbox();
      return `Released request #${id}`;
    });

  const cancel = (id: bigint) =>
    run('Cancelling…', async () => {
      const h = await writeContractAsync({ address: REQUESTS, abi: REQUEST_ABI, functionName: 'cancel', args: [id] });
      await waitForTransactionReceipt(client, { hash: h });
      await loadInbox();
      return `Cancelled #${id} — your money is back`;
    });

  // ---------------------------------------------------------------- render

  if (!isConnected) {
    return (
      <div style={{ fontFamily: 'ui-sans-serif, system-ui', maxWidth: 460, margin: '60px auto', padding: 20 }}>
        <div style={card}>
          <h1 style={{ margin: '0 0 6px', fontSize: 22 }}>Send</h1>
          <p style={{ color: '#8b95a5', margin: '0 0 20px', fontSize: 14 }}>
            Pay anyone by username. Ask for USDC with one tap to release.
          </p>
          {connectors.map((c) => (
            <button key={c.id} onClick={() => connect({ connector: c })} style={{ ...btn('#10b981'), width: '100%' }}>
              Connect wallet
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'ui-sans-serif, system-ui', maxWidth: 520, margin: '0 auto', padding: 20 }}>
      <header style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: 1, color: '#6d7787', textTransform: 'uppercase' }}>Arc mainnet</div>
        <h1 style={{ margin: '4px 0 0', fontSize: 24 }}>Send</h1>
        <div style={{ fontSize: 13, color: '#6d7787', marginTop: 4 }}>{short(address!)}</div>
      </header>

      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {([['ask', 'Ask'], ['send', 'Send'], ['inbox', 'Inbox']] as const).map(([k, l]) => (
          <button key={k} onClick={() => { setTab(k); if (k === 'inbox') loadInbox(); }}
            style={{ ...btn(tab === k ? '#10b981' : '#1a212c', tab === k ? '#04150f' : '#c8cfda'), flex: 1, padding: '10px' }}>
            {l}
          </button>
        ))}
      </div>

      {err && <div style={{ ...card, borderColor: '#5c2530', background: '#1c1114', color: '#ff9aa8', fontSize: 13, marginBottom: 14 }}>{err}</div>}
      {note && <div style={{ ...card, borderColor: '#1c4a3a', background: '#0d1a15', color: '#7ee2b8', fontSize: 13, marginBottom: 14 }}>{note}</div>}

      {tab === 'ask' && (
        <div style={card}>
          <div style={label}>Your username</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            <input style={{ ...input, marginBottom: 0 }} placeholder="adaeze" value={name}
              onChange={(e) => { setName(e.target.value); setNameState({}); }} />
            <button onClick={claim} disabled={!!busy || !name} style={{ ...btn('#1a212c', '#c8cfda'), whiteSpace: 'nowrap' }}>
              {busy ?? (nameState.done ? 'Claimed' : 'Claim')}
            </button>
          </div>
          {nameState.taken && <div style={{ fontSize: 12, color: '#ff9aa8', marginTop: -12, marginBottom: 16 }}>That name is taken.</div>}

          <div style={label}>Ask someone for USDC</div>
          <input style={input} placeholder="username" value={to} onChange={(e) => setTo(e.target.value)} />
          <input style={input} placeholder="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input style={input} placeholder="what is it for?" value={purpose} onChange={(e) => setPurpose(e.target.value)} />

          <label style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 13, color: '#8b95a5', margin: '4px 0 16px' }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Anyone can trigger the release (one tap, or from a link)
          </label>

          <button onClick={ask} disabled={!!busy} style={{ ...btn('#10b981'), width: '100%' }}>
            {busy ?? 'Request USDC'}
          </button>
          <p style={{ fontSize: 12, color: '#6d7787', marginTop: 12, lineHeight: 1.5 }}>
            Your USDC is held safely and stays refundable until you release it.
          </p>
        </div>
      )}

      {tab === 'send' && (
        <div style={card}>
          <div style={label}>Send to a username</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <input style={{ ...input, marginBottom: 0 }} placeholder="username" value={sendTo} onChange={(e) => { setSendTo(e.target.value); setLookup(null); }} />
            <button onClick={find} style={{ ...btn('#1a212c', '#c8cfda'), whiteSpace: 'nowrap' }}>Find</button>
          </div>

          {lookup && (
            <div style={{ fontSize: 13, color: '#7ee2b8', marginBottom: 14 }}>
              @{(sendTo || '').replace(/^@/, '').toLowerCase()} → {short(lookup)}
            </div>
          )}

          <input style={input} placeholder="amount" inputMode="decimal" value={sendAmt} onChange={(e) => setSendAmt(e.target.value)} />
          <button onClick={send} disabled={!!busy || !lookup} style={{ ...btn('#10b981'), width: '100%', opacity: lookup ? 1 : 0.4 }}>
            {busy ?? 'Send USDC'}
          </button>
        </div>
      )}

      {tab === 'inbox' && (
        <div>
          {inbox.length === 0 && (
            <div style={{ ...card, color: '#6d7787', fontSize: 14, textAlign: 'center' }}>
              {busy ?? 'Nothing waiting for you.'}
            </div>
          )}
          {inbox.map((r) => (
            <div key={r.id.toString()} style={{ ...card, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span style={{ fontSize: 18, fontWeight: 650 }}>{usdc(r.amount)} USDC</span>
                <span style={{ fontSize: 11, color: '#6d7787', textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  {STATUS[r.status]}
                </span>
              </div>
              <div style={{ fontSize: 13, color: '#8b95a5', marginBottom: 4 }}>{r.purpose}</div>
              <div style={{ fontSize: 12, color: '#6d7787', marginBottom: 12 }}>
                from {short(r.requester)}{r.autoRelease ? ' · one-tap release' : ''}
              </div>
              {r.status === 1 && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => release(r.id)} disabled={!!busy} style={{ ...btn('#10b981'), flex: 1 }}>Release</button>
                  <button onClick={() => cancel(r.id)} disabled={!!busy} style={{ ...btn('#1a212c', '#c8cfda') }}>Cancel</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
