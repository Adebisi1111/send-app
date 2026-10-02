import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, parseAbi, getContract, formatUnits } from 'viem';

const RPC = process.argv[2] ?? 'https://rpc.mainnet.arc.io';
const arc = {
  id: 5042, name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const USDC = '0x3600000000000000000000000000000000000000';
const REG = '0x71508725F355cf017B42Bccd878cff3c8a0bE641';
const REQ = process.env.REQ ?? '0x5fdd3cec76f356d707bfe6fb01029f431f5efca5';

const key = readFileSync('/home/administrator/.arc-deployer.key', 'utf8').trim();
const me = privateKeyToAccount(key);
console.log('payer   :', me.address);

const pub = createPublicClient({ chain: arc, transport: http(RPC) });
const wallet = createWalletClient({ account: me, chain: arc, transport: http(RPC) });

const erc20 = getContract({
  address: USDC, client: pub,
  abi: parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function decimals() view returns (uint8)',
  ]),
});
const req = getContract({
  address: REQ, client: pub,
  abi: parseAbi([
    'function askAnyone(string purpose,uint256 amount,uint256 expiry) returns (uint256)',
    'function statusOf(uint256) view returns (uint8)',
    'function remaining(uint256) view returns (uint256)',
    'function payRemaining(uint256) returns (uint256)',
    'function pay(uint256,uint256)',
    'function paidBy(uint256,address) view returns (uint256)',
    'function openUnnamedCount() view returns (uint256)',
    'function nextId() view returns (uint256)',
  ]),
});
const reg = getContract({
  address: REG, client: pub,
  abi: parseAbi([
    'function register(string username) returns (string)',
    'function usernameOf(address) view returns (string)',
    'function isTaken(string) view returns (bool)',
  ]),
});

const bal = async (w) => Number(formatUnits(await erc20.read.balanceOf([w]), 6)).toFixed(4);
const D = 10n ** 6n;
const now = BigInt(Math.floor(Date.now() / 1000));
const expiry = now + 30n * 24n * 3600n;

console.log('\n== 1. claim a username ==');
const name = 'sendtest' + String(Number(me.address.slice(2, 6), 16) % 9000 + 1000);
try {
  const h = await wallet.writeContract({ address: REG, abi: reg.abi, functionName: 'register', args: [name] });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  console.log('claimed :', r.status === 'success' ? '@' + name : 'FAILED');
  console.log('  tx    :', h);
} catch (e) { console.log('claim err:', String(e.shortMessage ?? e.message).slice(0, 110)); }
console.log('usernameOf:', await reg.read.usernameOf([me.address]));

console.log('\n== 2. ask anyone for 0.05 USDC ==');
console.log('balance before ask:', await bal(me.address));
const h2 = await wallet.writeContract({
  address: REQ, abi: req.abi, functionName: 'askAnyone',
  args: ['e2e mainnet proof', 15n * D / 100n, expiry],
});
const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
console.log('ask tx  :', h2);
const id = await req.read.nextId() - 1n;
console.log('request :', id.toString());
console.log('balance after ask (must be unchanged):', await bal(me.address));
console.log('status  :', await req.read.statusOf([id]), '(1 = Open)');
console.log('remain  :', formatUnits(await req.read.remaining([id]), 6));

console.log('\n== 3. approve + pay in full ==');
const amt = await req.read.remaining([id]);
const h3 = await wallet.writeContract({ address: USDC, abi: erc20.abi, functionName: 'approve', args: [REQ, amt] });
const r3 = await pub.waitForTransactionReceipt({ hash: h3 });
console.log('approve :', r3.status === 'success' ? 'OK' : 'FAILED');
console.log('  tx    :', h3);

const payAmt = 10n * D / 100n; // 0.10 partial of 0.15
const h4 = await wallet.writeContract({ address: REQ, abi: req.abi, functionName: 'pay', args: [id, payAmt] });
const r4 = await pub.waitForTransactionReceipt({ hash: h4 });
console.log('pay     :', r4.status === 'success' ? 'OK' : 'FAILED');
console.log('  tx    :', h4);
console.log('status  :', await req.read.statusOf([id]), '(2 = Paid)');
console.log('balance after pay:', await bal(me.address));
console.log('openUnnamedCount :', await req.read.openUnnamedCount());
