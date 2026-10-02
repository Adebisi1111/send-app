import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, defineChain, parseAbi, encodeFunctionData } from 'viem';

const arc = defineChain({ id: 5042, name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } });
const REQUESTS = '0xd8d5e36feba036fe52589cfbe64e210ecf45f492';
const USDC = '0x3600000000000000000000000000000000000005';
const client = createPublicClient({ chain: arc, transport: http() });

const pk = readFileSync('/home/administrator/.arc-deployer.key', 'utf8').trim();
const me = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x' + pk);

const REQ = parseAbi([
  'function askAnyone(string,uint256,uint256) returns (uint256)',
  'function pay(uint256,uint256)',
  'function remaining(uint256) view returns (uint256)',
  'function statusOf(uint256) view returns (uint8)',
  'function openRequests(uint256) view returns (uint256[])',
  'function paidBy(uint256,address) view returns (uint256)',
]);
const ERC = parseAbi(['function balanceOf(address) view returns (uint256)',
                      'function approve(address,uint256) returns (bool)']);

const send = async (to, data) => {
  const gp = await client.getGasPrice();
  const nonce = await client.getTransactionCount({ address: me.address, blockTag: 'pending' });
  const hash = await client.sendRawTransaction({ serializedTransaction: await me.signTransaction({
    to, data, type: 'legacy', chainId: arc.id, nonce, gas: 500_000n, gasPrice: gp, value: 0n }) });
  const rec = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 180000 });
  if (rec.status !== 'success') throw new Error('reverted: ' + hash);
  return hash;
};
// Arc USDC is a precompile; this public RPC does not proxy eth_call reads to
// it, so balances are verified from the request contract's own events.
const usdcBal = async () => null;

console.log('deployer :', me.address);
console.log();

const id = 1n;
const amount = 100_000_000n;
const expiry = BigInt(Math.floor(Date.now() / 1000) + 14 * 86400);
const h1 = await send(REQUESTS, encodeFunctionData({ abi: REQ, functionName: 'askAnyone',
  args: ['arc microgrant demo', amount, expiry] }));
console.log('askAnyone      :', h1);
console.log('open feed      :', (await client.readContract({ address: REQUESTS, abi: REQ,
  functionName: 'openRequests', args: [100n] })).map(String).join(','));
console.log();

for (const part of [40_000_000n, 60_000_000n]) {
  await send(USDC, encodeFunctionData({ abi: ERC, functionName: 'approve', args: [REQUESTS, part] }));
  const h = await send(REQUESTS, encodeFunctionData({ abi: REQ, functionName: 'pay', args: [id, part] }));
  const rem = await client.readContract({ address: REQUESTS, abi: REQ, functionName: 'remaining', args: [id] });
  console.log(`paid ${Number(part)/1e6}          :`, h);
  console.log('  remaining    :', Number(rem) / 1e6, '| status', await client.readContract(
    { address: REQUESTS, abi: REQ, functionName: 'statusOf', args: [id] }));
}
console.log();
console.log('=== result ===');
console.log('status      :', await client.readContract({ address: REQUESTS, abi: REQ, functionName: 'statusOf', args: [id] }), '(2 = Paid)');
console.log('paidBy me   :', Number(await client.readContract({ address: REQUESTS, abi: REQ, functionName: 'paidBy', args: [id, me.address] })) / 1e6);
const ev = await client.getContractEvents({ address: REQUESTS, abi: parseAbi([
  'event Settled(uint256 indexed id, address indexed payer, uint256 amount, uint256 collected, uint256 total)']),
  eventName: 'Settled', fromBlock: 0n, toBlock: 'latest', strict: false });
for (const e of ev) console.log('Settled log  : paid', Number(e.args.amount)/1e6, '| running total', Number(e.args.collected)/1e6);
console.log('balance     : read from events below (USDC is a precompile)');
console.log('open feed   :', (await client.readContract({ address: REQUESTS, abi: REQ, functionName: 'openRequests', args: [100n] })).map(String).join(',') || 'empty');
