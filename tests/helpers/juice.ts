// Shared helpers for the Juice pool / vault vitest suites. They run on the
// vault harness build (tests/vault/build.py): pox-5 -> .mock-pox, sBTC ->
// .mock-ft, Jing market -> .v6-market, router -> .mock-router, DIA ->
// .mock-dia, RFQ native price -> .mock-native. Simnet resets before each test.
import { Cl, ClarityValue, cvToString } from "@stacks/transactions";
import { expect } from "vitest";

const accounts = simnet.getAccounts();
export const admin = accounts.get("deployer")!;
export const alice = accounts.get("wallet_1")!;
export const bob = accounts.get("wallet_2")!;
export const carol = accounts.get("wallet_3")!;

export const POOL = "juice-pool-sbtc-signer";
export const VAULT = "juice-sbtc-autoswap";
export const POOL_ID = `${admin}.${POOL}`;
export const VAULT_ID = `${admin}.${VAULT}`;
export const ROUTER_ID = `${admin}.mock-router`;
export const UPDATE = Cl.bufferFromHex("");
export const STX = 1_000_000n;
export const OG_CAP = 2_100_000_000_000n;
export const REWARD_SATS = 1_000_000n; // mock-pox claim-rewards mint
export const MID = 32_000_000_000_000n; // mock Lazer / DIA cross
export const REWARD_STX = 3_200_000_000n; // 1e6 sats at MID through mock-router

// Pool functions that take the active vault as their last (trait) argument.
const VAULT_ARG = new Set([
  "pox-claim-rewards", "finalize-swap", "emergency-recover", "refloor-vault",
  "set-vault-window-blocks", "set-vault-leeway-bps", "set-vault-slippage-bps",
  "set-vault-max-chunk-sats", "set-vault-dia-band-bps", "set-vault-router-cooldown",
  "set-vault-no-pyth-slippage-bps", "jing-take", "router-swap-split", "router-swap-split-dia",
  "set-vault-pyth-fee-budget", "set-vault-maker-spread-bps",
  // harness-only wrappers appended by tests/vault/build.py
  "test-fund", "test-finish",
]);

export function cp(name: string) {
  return Cl.contractPrincipal(admin, name);
}

export function pool(fn: string, args: ClarityValue[] = [], sender = admin, vault = VAULT) {
  const full = VAULT_ARG.has(fn) ? [...args, cp(vault)] : args;
  return simnet.callPublicFn(POOL, fn, full, sender);
}

export function vault(fn: string, args: ClarityValue[] = [], sender = alice) {
  return simnet.callPublicFn(VAULT, fn, args, sender);
}

export function call(contract: string, fn: string, args: ClarityValue[] = [], sender = admin) {
  return simnet.callPublicFn(contract, fn, args, sender);
}

export function read(contract: string, fn: string, args: ClarityValue[] = []) {
  return simnet.callReadOnlyFn(contract, fn, args, admin).result;
}

export function readStr(contract: string, fn: string, args: ClarityValue[] = []) {
  return cvToString(read(contract, fn, args));
}

export function okValue(r: { result: ClarityValue }): any {
  expect(r.result.type, cvToString(r.result)).toBe("ok");
  return (r.result as any).value;
}

export function expectOk(r: { result: ClarityValue }) {
  expect(r.result.type, cvToString(r.result)).toBe("ok");
}

export function expectErr(r: { result: ClarityValue }, code: number) {
  expect(r.result).toBeErr(Cl.uint(code));
}

export function stx(who: string) {
  return simnet.getAssetsMap().get("STX")?.get(who) ?? 0n;
}

export function sbtc(who: string) {
  return (read("mock-ft", "get-balance", [Cl.principal(who)]) as any).value.value as bigint;
}

export function stake(who: string, cycle: number | bigint, amount: bigint) {
  const r = call("mock-pox", "stake-test", [cp(POOL), Cl.principal(who), Cl.uint(cycle), Cl.uint(amount)], admin);
  expectOk(r);
  return r;
}

// Cover the whole OG cap on an unused cycle so later stakers pay the fee.
export function fillOgCap() {
  stake(`${admin}.og-filler`, 999, OG_CAP);
}

export function fundRouter() {
  expectOk({ result: simnet.transferSTX(50_000_000_000n, ROUTER_ID, admin).result });
}

export function nextDist() {
  expectOk(call("mock-pox", "next-dist"));
}

// Claim the mock reward into the vault: opens a batch (pending swap).
export function claim(cycle: number, tranche = 0) {
  const r = pool("pox-claim-rewards", [Cl.list([]), Cl.uint(cycle)], alice);
  expectOk(r);
  expect(read(POOL, "get-tranche-count", [Cl.uint(cycle)])).toBeUint(tranche + 1);
  return r;
}

export function clock(): Record<string, any> {
  return (read(VAULT, "get-clock") as any).value;
}

export function batchOpen() {
  return clock()["batch-start"].type === "some";
}

export function readyToFinish() {
  return clock()["ready-to-finish"].type === "true";
}

// stake alice 1 : bob 3 (uSTX), claim, wait out the window, sell all, finalize
export function fullBatch(cycle: number) {
  stake(alice, cycle, 1n);
  stake(bob, cycle, 3n);
  claim(cycle);
  simnet.mineEmptyBurnBlocks(288);
  expectOk(vault("router-swap", [UPDATE]));
  const amount = okValue(pool("finalize-swap", [], alice));
  return amount.value as bigint;
}

export function principalsList(...who: string[]) {
  return Cl.list(who.map(function (w) { return Cl.principal(w); }));
}

// A test-only swap vault that implements the trait but is configurable and can
// lie (finish reports STX it never sends). Used to reach the pool's vault
// upgrade and transfer-mismatch guards.
export const FAKE_VAULT_SOURCE = `
(impl-trait .juice-swap-vault-trait-v2.swap-vault-trait)
(define-data-var pool-p principal .juice-pool-sbtc-signer)
(define-data-var start (optional uint) none)
(define-data-var resting uint u0)
(define-data-var parked uint u0)
(define-data-var status-fails bool false)
(define-data-var finish-claim uint u0)
(define-public (configure (p principal) (s (optional uint)) (r uint) (k uint) (f bool) (claim uint))
  (begin (var-set pool-p p) (var-set start s) (var-set resting r) (var-set parked k)
    (var-set status-fails f) (var-set finish-claim claim) (ok true)))
(define-public (fund (amount uint))
  (begin (try! (contract-call? .mock-ft transfer amount contract-caller current-contract none)) (ok amount)))
(define-public (finish) (ok (var-get finish-claim)))
(define-public (emergency-recover) (ok { stx: u0, sbtc: u0 }))
(define-read-only (get-upgrade-status)
  (if (var-get status-fails) (err u9)
    (ok { pool: (var-get pool-p), empty: true, sbtc-balance: u0, stx-balance: u0,
          batch-start: (var-get start), jing-resting: (var-get resting), jing-parked: (var-get parked) })))
(define-public (jing-refloor (update (buff 8192))) (ok u0))
(define-public (set-window-blocks (v uint)) (ok true))
(define-public (set-leeway-bps (v uint)) (ok true))
(define-public (set-slippage-bps (v uint)) (ok true))
(define-public (set-max-chunk-sats (v uint)) (ok true))
(define-public (set-dia-band-bps (v uint)) (ok true))
(define-public (set-router-cooldown (v uint)) (ok true))
(define-public (set-no-pyth-slippage-bps (v uint)) (ok true))
(define-public (set-pyth-fee-budget (v uint)) (ok true))
(define-public (set-maker-spread-bps (v uint)) (ok true))
(define-public (jing-take (a uint) (update (buff 8192)))
  (ok { notification: "jing-take", payload: { amount: a, limit-price: u0, out: u0 } }))
(define-public (router-swap-split (a uint) (j uint) (d uint) (x uint) (v uint) (update (buff 8192)))
  (ok { notification: "router-swap-split", payload: { amount: a, jing: j, dlmm: d, xyk: x, velar: v,
        limit-price: u0, velar-limit: u0, mid: u0, out: u0, unsold: u0 } }))
(define-public (router-swap-split-dia (a uint) (d uint) (x uint) (v uint))
  (ok { notification: "router-swap-split-dia", payload: { amount: a, dlmm: d, xyk: x, velar: v,
        mid: u0, limit-price: u0, price-source: "dia", dia-error: none, out: u0, unsold: u0 } }))
`;

export function deployFakeVault(name = "fake-vault") {
  simnet.deployContract(name, FAKE_VAULT_SOURCE, { clarityVersion: 4 }, admin);
  return name;
}

export function configureFake(name: string, opts: {
  pool?: string; start?: number; resting?: number; parked?: number; fails?: boolean; claim?: bigint;
} = {}) {
  expectOk(call(name, "configure", [
    Cl.principal(opts.pool ?? POOL_ID),
    opts.start === undefined ? Cl.none() : Cl.some(Cl.uint(opts.start)),
    Cl.uint(opts.resting ?? 0),
    Cl.uint(opts.parked ?? 0),
    Cl.bool(opts.fails ?? false),
    Cl.uint(opts.claim ?? 0n),
  ]));
}
