;; Title: drip
;;
;; What this contract does:
;; This is the keeper trigger -- a simple contract that anyone can call to
;; release the next slice of sBTC rewards from the yield contract into the
;; share tracking system.
;;
;; Why it exists:
;; The yield contract holds sBTC rewards and releases them gradually across
;; a PoX cycle (~30 drips, one every ~70 blocks). But someone needs to
;; actually call yield.drip() each time. This contract is that trigger.
;;
;; It enforces a minimum interval between drips so no one can drain rewards
;; faster than intended. Anyone can call it (permissionless keeper) -- the
;; incentive is that keeping the protocol healthy benefits all jSTX holders.
;;
;; In production, this would be called by a bot/cron job every ~10 minutes.
;;
;; Inspired by: StackingDAO rewards-job-v1.clar
;; Source: stacking-dao/contracts/keeper-jobs/rewards-job-v1.clar

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------
(define-constant ERR_TOO_EARLY (err u12001))

;; Minimum blocks between drips (~70 blocks = ~70 minutes on mainnet)
(define-constant MIN_DRIP_INTERVAL u70)

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

;; Last block height when a drip was executed
(define-data-var last-drip-height uint u0)

;; ---------------------------------------------------------
;; Public: trigger a drip
;; ---------------------------------------------------------

;; Anyone can call this. If enough blocks have passed since the last drip,
;; it calls yield.drip() to release the next slice of rewards.
(define-public (trigger (cycle uint))
  (begin
    (asserts!
      (>= burn-block-height (+ (var-get last-drip-height) MIN_DRIP_INTERVAL))
      ERR_TOO_EARLY
    )
    (var-set last-drip-height burn-block-height)
    (try! (contract-call? .yield drip cycle))
    (print { action: "drip-triggered", cycle: cycle, height: burn-block-height })
    (ok true)
  )
)

;; ---------------------------------------------------------
;; Read-only
;; ---------------------------------------------------------

(define-read-only (get-last-drip-height)
  (var-get last-drip-height)
)

(define-read-only (blocks-until-next-drip)
  (let (
    (next-allowed (+ (var-get last-drip-height) MIN_DRIP_INTERVAL))
  )
    (if (>= burn-block-height next-allowed)
      u0
      (- next-allowed burn-block-height)
    )
  )
)
