# Send

Send USDC to anyone by username on Arc. Ask someone for USDC against a stated
purpose, and let them pay you — nothing is held in between.

A wallet address is 42 characters and impossible to remember or check. `@adaeze` is
neither.

## The model

The person who asks is the person who receives.

```
Alice (asks)              Bob (accepts)
wants to RECEIVE   ←────  pays from his own wallet
```

Nothing is escrowed. A request is a claim; settling it moves the payer's own USDC
straight to the requester, wallet to wallet. There is no contract in the middle
holding money, so there is no balance that can get stuck and no refund path that
can go wrong.

That also enables three things Cash App cannot do:

- **Open requests.** `askAnyone` names nobody, so anyone holding the link can
  settle it. A group gift becomes genuinely open rather than "text Bob and hope".
- **Partial payments.** `pay(id, amount)` takes any value up to what is left.
  Several people can chip into one request, and it settles exactly when the total
  is reached.
- **Nothing to lose.** No escrow means nothing to strand.

## Live on Arc mainnet

| contract         | address                                      |
| ---------------- | -------------------------------------------- |
| PaymentRequest   | `0xd8d5e36feba036fe52589cfbe64e210ecf45f492` |
| UsernameRegistry | `0x71508725F355cf017B42Bccd878cff3c8a0bE641` |
| USDC             | `0x3600000000000000000000000000000000000005` |

Chain 5042. An earlier deployment at `0xc1e3a7b06b39aabb11e639cf5e2dad171a8a712e`
is inert — its constructor arguments were supplied in the wrong order. Ignore it.

## Verified

On mainnet, request #1 is live and readable:

```
statusOf(1)       1  (Open)
remaining(1)      100 USDC
openUnnamedCount  1
purpose           "arc microgrant demo"
```

25 contract tests and 11 frontend tests.

```bash
forge test        # 25 passing
npx vitest run    # 11 passing
```

The tests cover the parts that are easy to get wrong: that asking escrows
nothing, that `pay` moves money from payer to requester, that a stranger can
settle an open request, that 40 + 60 settles exactly at 100, that a partial
payment keeps the request open, that `close` leaves the asker holding what was
already paid, and that the open-request feed drops settled ids without
disturbing the others.

Both flows were also driven through a browser against a local chain: Alice asks
100 USDC naming nobody, Bob pays 30 from **To Pay**, Carol pays the remaining 70
from **Open**. Balances land at 10100 / 9970 / 9930 with the contract holding 0.
Sending by username was checked the same way — 12.5 USDC moved 20000 → 19987.5
and 10000 → 10012.5.

### Not yet proven on mainnet

The payment leg has not completed over the public RPC. Arc USDC is a
precompile, and `rpc.mainnet.arc.io` does not proxy `eth_call` reads or
transactions to it, so `approve` reverts. Asking works; settling needs a wallet,
which talks to the precompile directly.

## Why Arc

USDC is the gas token on Arc, so the asset being moved also pays for the
transfer. Measured on mainnet:

| step        | cost       |
| ----------- | ---------- |
| deploy      | 0.0313 USDC |
| askAnyone   | 0.0048 USDC |

Posting a request costs about half a cent. On a chain where gas is a different
asset, small peer-to-peer payments do not clear that bar — the fee eats the
amount. Arc is what makes "ask for $4, get paid in a tap" worth building.

## Contracts

Both written from scratch, no external dependencies beyond the ERC-20 interface.

### `UsernameRegistry`

Maps a name to an address.

- case-insensitive: `resolve("ADAEZE")` finds `adaeze`
- one name per address, names transferable
- rejects dots and dashes so a name cannot imitate a domain
- 3–32 characters, `[a-z0-9_]` only

### `PaymentRequest`

1. `ask(username, purpose, amount, expiry)` — ask a named person. The name is
   resolved at ask time and the address is fixed from then on.
2. `askAnyone(purpose, amount, expiry)` — ask nobody in particular. Anyone may
   settle it.
3. `pay(id, amount)` — pay any amount up to what remains. The payer approves
   exactly that amount; no blanket allowance. The last payment moves the request
   to `Paid` and emits `Settled` with the running total.
4. `payRemaining(id)` — settle the rest in one call.
5. `cancel(id)` — close a request nobody has paid.
6. `close(id)` — stop a partly paid request. The asker keeps what was paid.

Status is `None`, `Open`, `Paid`, `Cancelled`. `paidBy(id, payer)` records what
each person contributed. Expiry is capped at 90 days and enforced on chain;
purposes are capped at 140 characters.

Because nothing is escrowed, `cancel` and `close` move no money. They only
change state.

## Running the frontend

```bash
npm install
npm run dev
```

The app targets Arc mainnet by default. Override with `VITE_RPC`, `VITE_USDC`,
`VITE_REGISTRY`, and `VITE_REQUESTS` in `src/pay.ts`.

## Running the mainnet proof

`mainnet-proof.mjs` posts a request and settles it in two parts. It needs a
funded key on disk:

```bash
node mainnet-proof.mjs
```

It reads `/home/administrator/.arc-deployer.key`, which is not in this repo.
Point that path at your own key file, or edit it.

## Live

https://adebisi1111.github.io/send-app

## Layout

```
contracts/
  UsernameRegistry.sol     name -> address
  PaymentRequest.sol       ask / pay / cancel / close
  test/                    25 tests
src/
  Pay.tsx                  the app: Send, Ask, To Pay, Open, Mine
  pay.ts                   addresses, ABIs, formatting
```
