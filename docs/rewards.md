# WLF rewards

A node earns **WLF** points when it answers requests from **other people's** nodes. Running your own node for yourself earns nothing.

**WLF are points, not a token.** They have no value and no promised redemption. A later redemption as a token on Ethereum is a plan. Before promising anyone that WLF will become a token, get legal advice: in many countries a token people expect to gain value can count as a security, and rewards can be taxable.

## How it works

1. **Receipt.** When node A's request is answered by node B, A signs a receipt and sends it to B over `/werewolf-mesh/receipt/1.0.0`. The receipt records who asked, who answered, the model, token counts and time. It contains **no prompt or answer text and no IP address**.
2. **Check.** B keeps a receipt only if:
   - it matches a job B really ran for A, with the same request, the same model, and token counts within ±2;
   - A's key signed it;
   - B hasn't seen it before.

   Both sides also note whether the other came from their **own network**.
3. **Export.** Once a day or a week, each operator runs `./mesh rewards export` and sends the file to the settler. The file holds the node's receipts plus its "vouches" (the peers it approved), all signed.
4. **Settle.** The settler runs `./mesh rewards settle --epoch 2026-09-29 --in bundles/`. The rules below turn the receipts into the day's WLF, and the result is signed. Nodes import it with `./mesh rewards import`, and accept it only when it's signed by the settler set in `rewards.settler`.
5. **Verify.** Anyone with the same bundles can run `./mesh rewards verify settlement.json --in bundles/`. Settlement is deterministic, so a settler who changes the numbers is caught.

## The rules (per UTC day)

| Rule | Why |
|---|---|
| No receipt for local answers | Your own use never earns |
| Not credited if **either side** saw the other on its own network: loopback, LAN, CGNAT, the same public IPv4, or the same IPv6 /56 | Several nodes at home cannot farm each other. The cost: people sharing one internet connection don't earn from each other |
| Not credited for test runtimes, answers under 16 tokens, or duplicate receipts | No placeholder output, no padding, no replays |
| Credit = (answer tokens + ¼ prompt tokens) × model size (GB) × **the requester's trust** | Bigger models cost more to run. Only requests from trusted people count |
| Each requester can credit at most 50,000 work units a day, across all workers | Bounds what any one account, even a colluding one, can hand out |
| A node **qualifies** with ≥ 1,000 credit from ≥ 2 different trusted requesters | A single friend can't make a farm node qualify |
| **Daily pool** = sum over qualified nodes of 100 WLF × node weight, **halved at each doubling from 16 nodes**: 16–31 nodes → 50 each, 32–63 → 25, … | Your step-down: per-node rewards halve as the network grows, so total daily WLF stays about flat |
| Node weight = 2 × the trust of the people it served, by their share of use, at most 1 | Fake nodes and fake users cannot grow the pool beyond the trust they actually hold |
| The pool is shared among qualified nodes in proportion to credit | More real use earns more |

### Trust

Trust starts from **seeds**: the settler's own nodes and any founders it names with `--seeds`. Seeds have trust 1.

- A peer approved by a seed gets 0.5.
- A peer with trust *t* who vouches for *n* others gives each **0.5·t/n**. Trust is conserved: everything downstream of one person never adds up to more than that person's trust.
- Trust passes at most 4 vouches deep.
- Seeds don't split: a founding or bootstrap node legitimately approves many peers.

A vouch is simply "I approved this peer" (`./mesh peers approve`), signed inside each node's bundle.

## Threat model

| Attack | What stops it | What doesn't |
|---|---|---|
| Earning from your own requests | No receipt for local answers | — |
| Two or ten nodes at home serving each other | Same-network rule on both sides | A farmer with nodes in different places (VPSes) → see next rows |
| Colluding nodes signing receipts for work never done (keys are free; receipts only prove a claim) | Receipts from **untrusted** requesters count for nothing. A ring of fake accounts vouching for each other is unreachable from the seeds, so its trust is 0 (tested) | Collusion by someone the network trusts → next rows |
| One trusted person vouching for many fake "users" | Trust is conserved: 1,000 fakes share 0.5·t between them, which is below the minimum (tested) | — |
| A trusted person feeding a farm node fake work | One requester can't make a node qualify, and each requester's credit is capped per day (tested) | Two trusted colluders can qualify one farm node, up to 2 × cap × trust. This is bounded, visible in the receipts (the same pairs every day), and the vouchers are accountable: revoke them and whoever vouched for them loses trust |
| Spinning up empty nodes to shrink everyone's share (griefing the halving) | Only qualified nodes count, and node weight follows real trusted use (tested: 20 empty nodes change nothing) | — |
| Fake nodes to inflate the node-count pool | Pool weight comes from the trust of the users served, not the number of nodes (tested: 8 farms fed by 8 fakes add at most 50 WLF, not 800) | — |
| A worker inflating its token counts | The requester signs the counts; the worker only accepts a receipt that matches its own count | — |
| A requester lying to hurt a worker (claiming "same network") | — | Possible, but it only denies credit for its own requests; that worker can simply stop serving it |
| Forged or tampered receipts, bundles or settlements | Ed25519 signatures with separate domains for each kind; a node imports settlements only from its configured settler (tested) | — |
| Replaying old receipts | Unique IDs; duplicates are dropped by the worker and in settlement; each day is settled once | — |
| A dishonest settler | Signed, deterministic results that anyone can recompute (`rewards verify`) | Withholding someone's bundle can only be noticed by people who have that bundle. Moving to on-chain submission (below) would remove the settler's discretion |
| Quality fraud (fast garbage answers) | Receipts only for completed answers; a requester won't keep using a bad worker | Not yet: spot checks where seed nodes send test prompts at temperature 0 and compare word for word (splitting showed outputs are exactly reproducible) |
| Privacy | Receipts hold no text and no IP addresses | Bundles show **who used whom, when and how much**. The settler sees that usage graph. Share bundles only with the settler you trust |

**The honest summary:** in an open network, anyone can create accounts for free, so no technical rule alone can make farming impossible. These rules make it depend on **trust you grant by hand**. Farming then needs people you vouched for, it's capped, and it leaves a signed trail back to whoever vouched.

## Parameters

Defaults are in `apps/node/src/rewards/settle.ts` (`DEFAULT_PARAMS`). A settlement records the parameters it used, so changing them never changes past days. Tune these before launch:
- the 100 WLF allowance;
- the 16-node halving start;
- the 50,000 daily cap per requester;
- the qualification thresholds.

## Testing at home

Your own machines share a network, so strict settlement credits them nothing (tested with a PC and a homelab server on one LAN: 10 receipts, all excluded). For a home test, the settler can run:

```bash
./mesh rewards settle --epoch 2026-09-29 --in bundles/ --count-same-network --param qualifyMinRequesters=1
```

Every overridden parameter is written into the signed settlement, so a test settlement is recognisable as one. `settle` also saves the settler's own bundle into `bundles/`, so `./mesh rewards verify` can recompute it from that folder alone.

In that test, the PC serving Qwen3 8B on its GPU earned the day's 100 WLF. The homelab serving SmolLM2 135M did not qualify: model size weights the credit (4.7 vs 0.1), and two of its answers were under 16 tokens.

## Setup

- Choose the settler (for now: your node). On every node, set `"rewards": {"settler": "<your peer ID>"}` in `node.json`.
- Earning is on by default (`rewards.enabled`). The fake test runtime never earns.
- `./mesh rewards` shows receipts and your settled balance; the *Computer* page shows the same.

## Not built yet

- Automatic bundle submission (today: export a file and send it).
- Spot-check audits for answer quality.
- On-chain claims: the settlement already carries a Merkle root over `peer:wlf`, but an Ethereum claim contract would use keccak256 and a wallet mapping per peer. That design, and the legal questions, come first.
