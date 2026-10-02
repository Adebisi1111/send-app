# Send

Send USDC to anyone by username on Arc. Ask someone for USDC against a stated
purpose, and let them pay you — nothing is held in between.

A wallet address is 42 characters and impossible to remember or check. `@adaeze`
is neither.

## The model

The person who asks is the person who receives.

```
Alice (asks)              Bob (accepts)
wants to RECEIVE   ←────  pays from his own wallet
```

A request is a claim, not an escrow. Settling it moves the payer's own USDC
straight from their wallet to the requester. There is no contract holding money
in between, so there is no balance that can get stuck and no refund path that
can go wrong.

That is also what lets the named payer **decline**. A decline closes the
request, moves nothing, and is final — the same payer cannot reverse it and pay
later. `responded[id][payer]` records that they have answered, and only the
person named in the request may decline at all.

## Live on Arc mainnet

| contract         | address                                      |
| ---------------- | -------------------------------------------- |
| PaymentRequest   | `0x55484b461534e065e3e46f13c20c89d26b913339` |
| UsernameRegistry | `0x16aad5a31b750d9cc5641117d335b1ec848a6478` |
| USDC             | `0x3600000000000000000000000000000000000000` |

Chain 5042. Earlier deployments are inert and should be ignored:
`0xc1e3a7b06b39aabb11e639cf5e2dad171a8a712e` (constructor arguments supplied in
the wrong order), `0xd8d5e36feba036fe52589cfbe64e210ecf45f492` (built against a
USDC address that is not a contract on Arc), and the first working pair
`0x71508725f355cf017b42bccd878cff3c8a0be641` / `0xe71c9a722605ff6541d659a685f968349624e075`,
superseded after an audit. All four came from mistakes, and all are recorded
here rather than quietly dropped.

The first working pair is worth explaining, because the flaws were only found by
asking someone who had not written it. An audit of that bytecode found two real
bugs: the requester could settle their own request, moving no money while
marking it Paid, and `transferUsername` could orphan a name permanently. Both are
fixed above, and both fixes were proven against the deployed bytecode on mainnet
rather than only in tests.

## The app

Four tabs, and each one answers a different question.

| tab         | question it answers                           |
| ----------- | --------------------------------------------- |
| **Send**    | who do I want to pay, and how much?           |
| **Request** | who do I want to ask, for what, and how much? |
| **Pending** | what is waiting on my answer?                 |
| **History** | what already happened?                        |

Request takes a username, an amount and a purpose. Asking costs about half a
cent and locks nothing — the balance does not move, because no escrow exists.

Pending lists what you might pay or decline. A request naming you shows **Pay**
and **Decline**. History is a record and offers no controls.

Settling uses an exact allowance: the payer approves precisely the amount being
settled, never an open-ended one.

## Verified on mainnet

Registration and the request path have been driven end to end:

```
@ife registered   0x48d3cd11…c874   block 23914000
@adaeze           0x59a8fd5c…1213
```

Pay and Decline were exercised by hand across two wallets on the earlier pair.
On the current contracts both audit fixes were then confirmed by sending real
transactions and reading the resulting chain state:

- the requester attempted to settle a request they had made themselves; the
  transaction reverted and `statusOf` stayed `Open` with `totalSettled` at zero,
  which is what a pre-fix contract would have shown as `Paid` with phantom value
- a username was pushed onto an address already holding one; the transaction
  reverted and the name still resolved to its real owner, while a transfer to a
  name-less address in the same block succeeded

`125` contract tests and `36` frontend tests:

```bash
forge test        # 125 passing
npx vitest run    # 36 passing
```

The contract suite covers what is easy to get wrong: that asking escrows
nothing, that `pay` moves money from payer to requester rather than through the
contract, that the requester cannot decline their own request, that a stranger
cannot decline someone else's, that a partly paid request cannot be declined,
that a decline cannot be reversed by a later payment, and that `close` leaves
the asker holding what was already collected.

The frontend suite pins the bugs that actually shipped, each with the real
values from mainnet rather than invented ones: address casing (the raw decoder
returns lowercase while wagmi returns checksummed, so `===` never matched and
the Decline button could not render), amount formatting (USDC has six decimals,
and rounding to four turned a real request into `0 USDC`), and the ordering of
merged request lists.

## Why Arc

USDC is the gas token, so the asset being moved also pays for the transfer.

| step    | measured cost |
| ------- | ------------- |
| deploy  | 0.0313 USDC   |
| `ask`  | 0.0048 USDC   |

On a chain where gas is a different asset, small peer-to-peer payments do not
clear that bar — the fee eats the amount. Arc is what makes asking for a few
dollars worth building.

## Contracts

Both written from scratch. The only external dependency is the ERC-20 interface.

### `UsernameRegistry`

Maps a name to an address.

- case-insensitive: `resolve("ADAEZE")` finds `adaeze`
- one name per address, and names can be transferred
- rejects dots and dashes so a name cannot imitate a domain
- 3–32 characters, `[a-z0-9_]` only

### `PaymentRequest`

| function | purpose |
| -------- | ------- |
| `ask(username, purpose, amount, expiry)` | ask a named person; the address is fixed from that moment |
| `askAnyone(purpose, amount, expiry)` | ask nobody in particular |
| `pay(id, amount)` | pay any amount up to what remains |
| `payRemaining(id)` | settle the rest in one call |
| `decline(id)` | named payer only; closes it, moves nothing, final |
| `canRespond(id, account)` | whether the UI should offer Pay or Decline |
| `cancel(id)` | requester closes an unpaid request |
| `close(id)` | requester stops a partly paid one, keeping what was collected |
| `responded(id, payer)` | whether that payer has already answered |

Status is `None`, `Open`, `Paid`, `Cancelled`, `Declined`. Expiry is capped at
90 days and enforced on chain; purposes at 140 characters.

Because nothing is escrowed, `cancel`, `close` and `decline` move no money at
all. They only change state.

### Supported on chain, not offered in the app

`askAnyone` and partial `pay(id, amount)` remain in the contract and are tested,
but the app only creates named requests and only settles them in full. Open
requests already on chain can still be paid. The product is one person asking
one named person, so the controls for the rest were removed rather than left
half-wired.

## Running it

```bash
npm install
npm run dev
```

Targets Arc mainnet by default. Override with `VITE_RPC`, `VITE_USDC`,
`VITE_REGISTRY` and `VITE_REQUESTS` in `src/pay.ts`.

## Live

https://adebisi1111.github.io/send-app

## Layout

```
contracts/
  UsernameRegistry.sol     name -> address
  PaymentRequest.sol       ask / pay / decline / cancel / close
  test/                    125 tests
src/
  Pay.tsx                  the app
  pay.ts                   addresses, ABIs, formatting, error mapping
  index.css                design system
```