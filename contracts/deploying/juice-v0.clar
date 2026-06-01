(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

(define-constant ERR_NOT_OWNER (err u20001))
(define-constant ERR_PREVIOUS_NOT_DISTRIBUTED (err u20002))
(define-constant ERR_NO_REWARD (err u20003))
(define-constant ERR_NO_STAKERS (err u20004))
(define-constant ERR_ALREADY_DISTRIBUTED (err u20005))
(define-constant ERR_WRONG_CYCLE (err u20006))
(define-constant ERR_BACK_TO_THE_FUTURE (err u20007))

(define-constant DEPLOYER tx-sender)

(define-data-var contract-owner principal DEPLOYER)

(define-data-var active-cycle uint u0)

(define-data-var registration (list 200 { staker: principal, stx: uint }) (list))

(define-data-var total-stx uint u0)

(define-data-var distributed bool false)

(define-private (sum-stx (entry { staker: principal, stx: uint }) (acc uint))
  (+ acc (get stx entry))
)

(define-private (payout-one
    (entry { staker: principal, stx: uint })
    (acc {
      reward: uint,
      total: uint,
      paid: uint,
      results: (list 200 { staker: principal, stx: uint, sbtc: uint })
    }))
  (let (
    (staker (get staker entry))
    (stx (get stx entry))
    (share (/ (* (get reward acc) stx) (get total acc)))
  )
    (if (> share u0)
      (begin
        (unwrap-panic (as-contract? ((with-ft SBTC "sbtc-token" share))
          (unwrap-panic (contract-call? SBTC transfer share current-contract staker none))))
        (merge acc {
          paid: (+ (get paid acc) share),
          results: (unwrap-panic (as-max-len?
            (append (get results acc) { staker: staker, stx: stx, sbtc: share })
            u200))
        })
      )
      acc
    )
  )
)

(define-public (register-stakers
    (cycle uint)
    (entries (list 200 { staker: principal, stx: uint })))
  (let ((last-active (var-get active-cycle)))
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_OWNER)
    (asserts! (>= cycle last-active) ERR_BACK_TO_THE_FUTURE)
    (if (is-eq cycle last-active)
      (asserts! (not (var-get distributed)) ERR_ALREADY_DISTRIBUTED)
      (asserts! (or (is-eq last-active u0) (var-get distributed))
        ERR_PREVIOUS_NOT_DISTRIBUTED)
    )
    (let ((total (fold sum-stx entries u0)))
      (var-set active-cycle cycle)
      (var-set registration entries)
      (var-set total-stx total)
      (var-set distributed false)
      (print {
        action: "register-stakers",
        cycle: cycle,
        count: (len entries),
        entries: entries,
        total-stx: total
      })
      (ok total)
    )
  )
)

(define-public (fund (amount uint))
  (begin
    (try! (contract-call? SBTC transfer amount tx-sender current-contract none))
    (print { action: "fund", from: tx-sender, amount: amount })
    (ok true)
  )
)

(define-public (distribute (cycle uint))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_OWNER)
    (asserts! (is-eq cycle (var-get active-cycle)) ERR_WRONG_CYCLE)
    (asserts! (not (var-get distributed)) ERR_ALREADY_DISTRIBUTED)
    (let (
      (total (var-get total-stx))
      (reward (unwrap-panic (contract-call? SBTC get-balance current-contract)))
    )
      (asserts! (> total u0) ERR_NO_STAKERS)
      (asserts! (> reward u0) ERR_NO_REWARD)
      (var-set distributed true)
      (let (
        (final (fold payout-one (var-get registration)
          { reward: reward, total: total, paid: u0, results: (list) }))
        (out (get paid final))
      )
        (print {
          action: "distribute",
          cycle: cycle,
          reward: reward,
          paid: out,
          dust: (- reward out),
          distributions: (get results final)
        })
        (ok out)
      )
    )
  )
)

(define-public (withdraw (amount uint))
  (let ((owner (var-get contract-owner)))
    (asserts! (is-eq tx-sender owner) ERR_NOT_OWNER)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? SBTC transfer amount current-contract owner none))))
    (print { action: "withdraw", amount: amount, recipient: owner })
    (ok true)
  )
)

(define-public (set-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_OWNER)
    (var-set contract-owner new-owner)
    (print { action: "set-owner", new-owner: new-owner })
    (ok true)
  )
)

(define-read-only (get-owner)
  (var-get contract-owner)
)

(define-read-only (get-sbtc-balance)
  (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract))
)

(define-read-only (get-active-cycle)
  (var-get active-cycle)
)

(define-read-only (get-registration)
  (var-get registration)
)

(define-read-only (get-total-stx)
  (var-get total-stx)
)

(define-read-only (is-distributed)
  (var-get distributed)
)

(define-read-only (get-projected-share (stx uint))
  (let (
    (total (var-get total-stx))
    (reward (get-sbtc-balance))
  )
    (if (> total u0)
      (/ (* reward stx) total)
      u0
    )
  )
)