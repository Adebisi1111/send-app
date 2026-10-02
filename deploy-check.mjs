import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, parseAbi, getContract } from 'viem';

const RPC = process.argv[2] ?? 'http://127.0.0.1:8545';
const arc = {
  id: 5042, name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const USDC = '0x3600000000000000000000000000000000000000';
const REG = '0x71508725F355cf017B42Bccd878cff3c8a0bE641';

const key = readFileSync('/home/administrator/.arc-deployer.key', 'utf8').trim();
const acct = privateKeyToAccount(key);

const art = JSON.parse(readFileSync('./contracts/out/PaymentRequest.sol/PaymentRequest.json', 'utf8'));
let bytecode = art.bytecode.object ?? art.bytecode;
if (!bytecode.startsWith('0x')) bytecode = '0x' + bytecode;

// constructor(address usdc, address usernames)
const ctorAbi = parseAbi(['constructor(address usdc, address usernames)']);

const pub = createPublicClient({ chain: arc, transport: http(RPC) });
const wallet = createWalletClient({ account: acct, chain: arc, transport: http(RPC) });

const hash = await wallet.deployContract({ abi: ctorAbi, bytecode, args: [USDC, REG] });
const rec = await pub.waitForTransactionReceipt({ hash });
const addr = rec.contractAddress;

console.log('deployed :', addr);
console.log('gas used :', rec.gasUsed.toString());
console.log('status   :', rec.status);

const c = getContract({
  address: addr, client: pub,
  abi: parseAbi(['function usdc() view returns (address)', 'function usernames() view returns (address)']),
});
const u = (await c.read.usdc()).toLowerCase();
const r = (await c.read.usernames()).toLowerCase();
console.log('usdc()      :', u);
console.log('usernames() :', r);
console.log('USDC MATCH  :', u === USDC.toLowerCase());
console.log('REG MATCH   :', r === REG.toLowerCase());
