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

const pub = createPublicClient({ chain: arc, transport: http(RPC) });
const wallet = createWalletClient({ account: acct, chain: arc, transport: http(RPC) });

const hash = await wallet.deployContract({
  abi: parseAbi(['constructor(address usdc, address usernames)']),
  bytecode, args: [USDC, REG],
});
const rec = await pub.waitForTransactionReceipt({ hash });
const addr = rec.contractAddress;
console.log('deployed :', addr, '| gas', rec.gasUsed, '| status', rec.status);

const c = getContract({
  address: addr, client: pub,
  abi: parseAbi([
    'function usdc() view returns (address)',
    'function usernames() view returns (address)',
    'function nextId() view returns (uint256)',
  ]),
});
console.log('USDC MATCH :', (await c.read.usdc()).toLowerCase() === USDC.toLowerCase());
console.log('REG MATCH  :', (await c.read.usernames()).toLowerCase() === REG.toLowerCase());
console.log('nextId     :', await c.read.nextId());
console.log('has decline:', art.abi.some((f) => f.name === 'decline'));
console.log('has canRespond:', art.abi.some((f) => f.name === 'canRespond'));
