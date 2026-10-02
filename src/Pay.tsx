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

// keccak256("getRequest(uint256)")[:4]
const GET_REQUEST = '0xc58343ef';

// ---------------------------------------------------------------- helpers

async function readRequest(id: bigint): Promise<Request | null> {
  // viem's generic struct decoder mis-handles this contract's two trailing
  // dynamic strings: it reads the offset words as lengths and throws on
  // unsafe integers. Decode the words directly instead — see mainnet-proof.mjs
  // for the confirmed layout.
  try {
    const data = (await client.request({
      method: 'eth_call',
      params: [{ to: REQUESTS, data: (GET_REQUEST + id.toString(16).padStart(64, '0')) as `0x${string}` }, 'latest'],
    })) as `0x${string}`;
    const hex2: string = data.slice(2);
    const b = new Uint8Array(hex2.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(hex2.substr(i * 2, 2), 16);
    const word = (i: number): bigint => {
      let s = '';
      for (let k = i * 32; k < (i + 1) * 32; k++) s += b[k].toString(16).padStart(2, '0');
      return BigInt('0x' + s || '0');
    };
    // Head/tail: w0 is the struct's byte offset; w3/w4 are the two string
    // offsets relative to it, each pointing at a length word.
    const base = Number(word(0));
    const str = (offsetWord: number): string => {
      const at = base + Number(word(offsetWord));
      let len = 0;
      for (let k = 0; k < 32; k++) len = len * 256 + b[at + k];
      let out = '';
      for (let k = at + 32; k < at + 32 + len; k++) out += String.fromCharCode(b[k]);
      return out;
    };
    const hex = (i: number): `0x${string}` =>
      ('0x' + word(i).toString(16).padStart(40, '0')) as `0x${string}`;
    return {
      id,
      requester: hex(1),
      recipient: hex(2),
      username: str(3),
      purpose: str(4),
      amount: word(5),
      expiresAt: word(6),
      status: Number(word(7)),
      autoRelease: word(8) === 1n,
    };
  } catch (e) {
    console.error('readRequest failed for id', id.toString(), e);
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

// ---------------------------------------------------------------- helpers

/** Status badge class for a request. 1 = Pending, 2 = Released. */
const badgeClass = (status: number): string =>
  status === 1 ? 'badge badge-pending' : status === 2 ? 'badge badge-released' : 'badge badge-cancel';

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
      const live = rs.filter((r): r is Request => !!r);
      // Pending first — a request you can act on must not sit below settled
      // history — then most recent first within each group.
      live.sort((a, b) => {
        const ap = a.status === 1 ? 0 : 1;
        const bp = b.status === 1 ? 0 : 1;
        return ap !== bp ? ap - bp : Number(b.id - a.id);
      });
      setInbox(live);
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
      <div className="connect">
        <div className="card connect-card">
          <div className="mark">S</div>
          <h1>Send USDC by username</h1>
          <p>Ask anyone for USDC and release it with one tap — or send it straight away.</p>
          {connectors.map((c) => (
            <button key={c.id} onClick={() => connect({ connector: c })} className="btn btn-lg btn-full">
              Connect {c.id === 'injected' ? 'browser wallet' : c.name}
            </button>
          ))}
          <div className="connect-note">
            Non-custodial. Your USDC sits in the request contract, never with us, and
            can be returned to you at any point before you release it.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <div className="mark">S</div>
          <span className="brand-name">Send</span>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="pill"><span className="dot" />Arc mainnet</div>
          <div className="wallet" style={{ marginTop: 6 }}>{short(address!)}</div>
        </div>
      </header>

      <div className="tabs" role="tablist">
        {([['ask', 'Ask'], ['send', 'Send'], ['inbox', 'Inbox']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k}
            onClick={() => { setTab(k); if (k === 'inbox') loadInbox(); }}
            className={`tab${tab === k ? ' tab-on' : ''}`}>
            {l}
          </button>
        ))}
      </div>

      {err && <div className="msg msg-err">{err}</div>}
      {note && <div className="msg msg-ok">{note}</div>}

      {tab === 'ask' && (
        <div className="card">
          <label className="label" htmlFor="claim-name">Your username</label>
          <div className="row">
            <input id="claim-name" className="field" placeholder="adaeze" value={name}
              onChange={(e) => { setName(e.target.value); setNameState({}); }} />
            <button onClick={claim} disabled={!!busy || !name} className="btn btn-ghost">
              {busy ?? (nameState.done ? 'Claimed' : 'Claim')}
            </button>
          </div>
          {nameState.taken && <div className="err-text">That name is taken.</div>}

          <label className="label label-sp" htmlFor="ask-to">Ask someone for USDC</label>
          <input id="ask-to" className="field" placeholder="username" value={to} onChange={(e) => setTo(e.target.value)} />
          <input id="ask-amt" className="field" placeholder="amount (USDC)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input id="ask-why" className="field" placeholder="what is it for?" value={purpose} onChange={(e) => setPurpose(e.target.value)} />

          <label className="check">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>Anyone can release this to me with one tap — turn off if you want to approve it yourself</span>
          </label>

          <button onClick={ask} disabled={!!busy} className="btn btn-lg btn-full">
            {busy ?? 'Request USDC'}
          </button>
          <p className="hint">
            Your USDC is held in the request contract and stays refundable until you release it.
          </p>
        </div>
      )}

      {tab === 'send' && (
        <div className="card">
          <label className="label" htmlFor="send-to">Send to a username</label>
          <div className="row">
            <input id="send-to" className="field" placeholder="username" value={sendTo} onChange={(e) => { setSendTo(e.target.value); setLookup(null); }} />
            <button onClick={find} className="btn btn-ghost">Find</button>
          </div>

          {lookup && (
            <div className="resolved">
              @{(sendTo || '').replace(/^@/, '').toLowerCase()} → {short(lookup)}
            </div>
          )}

          <input id="send-amt" className="field" style={{ marginTop: lookup ? 14 : 0 }} placeholder="amount (USDC)" inputMode="decimal" value={sendAmt} onChange={(e) => setSendAmt(e.target.value)} />
          <button onClick={send} disabled={!!busy || !lookup} className="btn btn-lg btn-full" style={{ marginTop: 16 }}>
            {busy ?? 'Send USDC'}
          </button>
        </div>
      )}

      {tab === 'inbox' && (
        <div className="stack">
          {inbox.length === 0 && (
            <div className="card empty">
              <div className="empty-mark">◎</div>
              {busy ?? 'Nothing waiting for you.'}
            </div>
          )}
          {inbox.map((r) => (
            <div key={r.id.toString()} className="card">
              <div className="req-head">
                <span className="req-amt">{usdc(r.amount)} USDC</span>
                <span className={badgeClass(r.status)}>{STATUS[r.status]}</span>
              </div>
              <div className="req-why">{r.purpose}</div>
              <div className="req-from">
                from {short(r.requester)}{r.autoRelease ? ' · one-tap release' : ''}
              </div>
              {r.status === 1 && (
                <div className="req-actions">
                  <button onClick={() => release(r.id)} disabled={!!busy} className="btn">Release</button>
                  <button onClick={() => cancel(r.id)} disabled={!!busy} className="btn btn-warn">
                    Cancel &amp; refund
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="foot">
        Non-custodial on Arc mainnet ·{' '}
        <a href="https://explorer.arc.io/address/0x285223c45050D7c93b8fF93Cc972580D2DD1f2EF" target="_blank" rel="noreferrer">
          contracts
        </a>
      </div>
    </div>
  );
}
