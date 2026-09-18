;; DRAFT: one sBTC -> STX vault per pool, adapted from CCD016 v2.
;; Deploy vault before pool, at the same address. No CityCoins/DAO dependencies.
;; One active batch. Defaults: 288 burn blocks maker-first, then oracle-floored
;; router chunks <= 0.05 BTC, separated by >= 1 burn block. Pool admin may tune
;; bounded settings; the window length may change only between batches.
(define-constant ERR_BUSY (err u16045))
(define-constant ERR_UNAUTHORIZED (err u16000))
(define-constant ERR_NO_FUNDS (err u16006))
(define-constant ERR_INVALID_PRICE (err u16013))
(define-constant ERR_WINDOW_CLOSED (err u16030))
(define-constant ERR_WINDOW_OPEN (err u16031))
(define-constant ERR_NO_CLOCK (err u16032))
(define-constant ERR_ORACLE_DIA (err u16035))
(define-constant ERR_ORACLE_STALE (err u16036))
(define-constant ERR_ORACLE_DIVERGED (err u16037))
(define-constant ERR_NO_BLOCK_TIME (err u16038))
(define-constant ERR_CHUNK_TOO_BIG (err u16039))
(define-constant ERR_SOME_FUNDS (err u16043))
(define-constant ERR_COOLDOWN (err u16044))
(define-constant ERR_OUT_OF_RANGE (err u16033))
(define-constant ERR_SPLIT_MISMATCH (err u16040))

(define-constant PRICE_PRECISION u100000000)
(define-constant DECIMAL_FACTOR u100)
(define-constant BPS_PRECISION u10000)

(define-constant POOL .juice-pool-stx-signer-stx-rewards)
(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant ASSET_SBTC "sbtc-token")
(define-constant WSTX_TOKEN 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2)
(define-constant ASSET_WSTX "wstx")

(define-constant JING_MARKET 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6)
(define-constant JING_ROUTER 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.swap-router-sbtc-stx-jing-v5)

(define-constant MAX_DIA_AGE u7200)
(define-constant MAX_WINDOW_BLOCKS u1008)
(define-constant MAX_LEEWAY_BPS u1000)
(define-constant MAX_SLIPPAGE_BPS u1000)
(define-constant MAX_DIA_BAND_BPS u5000)
(define-constant MAX_CHUNK_SATS u100000000)
(define-constant MAX_COOLDOWN_BLOCKS u144)
;; CityCoins' split path uses a separate 0.6% guard for Velar.
(define-constant VELAR_SLIPPAGE_BPS u60)

(define-data-var window-blocks uint u288)
(define-data-var leeway-bps uint u500)
(define-data-var slippage-bps uint u100)
(define-data-var max-chunk-sats uint u5000000)
(define-data-var dia-band-bps uint u1000)
(define-data-var router-cooldown-blocks uint u1)
(define-data-var last-router-swap uint u0)
(define-data-var batch-start (optional uint) none)

;; Settings are reachable only through the pool's admin wrappers.
(define-public (set-window-blocks (blocks uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    ;; Changing this during a batch would move its computed deadline.
    (asserts! (is-none (var-get batch-start)) ERR_BUSY)
    (asserts! (and (> blocks u0) (<= blocks MAX_WINDOW_BLOCKS)) ERR_OUT_OF_RANGE)
    (ok (var-set window-blocks blocks))
  )
)

(define-public (set-leeway-bps (bps uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (<= bps MAX_LEEWAY_BPS) ERR_OUT_OF_RANGE)
    (ok (var-set leeway-bps bps))
  )
)

(define-public (set-slippage-bps (bps uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (<= bps MAX_SLIPPAGE_BPS) ERR_OUT_OF_RANGE)
    (ok (var-set slippage-bps bps))
  )
)

(define-public (set-max-chunk-sats (sats uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (and (> sats u0) (<= sats MAX_CHUNK_SATS)) ERR_OUT_OF_RANGE)
    (ok (var-set max-chunk-sats sats))
  )
)

(define-public (set-dia-band-bps (bps uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (<= bps MAX_DIA_BAND_BPS) ERR_OUT_OF_RANGE)
    (ok (var-set dia-band-bps bps))
  )
)

(define-public (set-router-cooldown (blocks uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (<= blocks MAX_COOLDOWN_BLOCKS) ERR_OUT_OF_RANGE)
    (ok (var-set router-cooldown-blocks blocks))
  )
)

;; Unsolicited sBTC joins the next batch; a donation cannot block funding.
(define-public (fund (amount uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (is-none (var-get batch-start)) ERR_BUSY)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (contract-call? SBTC_TOKEN transfer amount POOL current-contract none))
    (var-set batch-start (some burn-block-height))
    (ok amount)))

;; Only the pool may finish, after every sat is sold and all market positions clear.
;; Do not clear the clock on a swap: the pool must first attribute the STX.
(define-public (finish)
  (let ((balance (stx-get-balance current-contract)))
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (is-some (var-get batch-start)) ERR_NO_CLOCK)
    (asserts! (is-empty) ERR_SOME_FUNDS)
    (try! (as-contract? ((with-stx balance))
      (try! (stx-transfer? balance current-contract POOL))))
    (var-set batch-start none)
    (ok balance)))

(define-public (jing-place (update (buff 8192)))
  (let (
      (floor (ask-of (try! (current-mid update))))
      ;; the whole balance, always: a caller chooses nothing but WHEN
      (amount (sbtc-balance))
    )
    (asserts! (window-open) ERR_WINDOW_CLOSED)
    (try! (check-amount amount))
    (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
      (try! (contract-call? JING_MARKET deposit-token-x amount floor (some u0) update
        SBTC_TOKEN ASSET_SBTC
      ))
    ))
    (ok (print { notification: "jing-place", payload: { amount: amount, floor: floor } }))
  )
)

(define-public (jing-reclaim)
  (begin
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (reclaim-core)
  )
)

;; Admin-only direct Jing liquidation. The pool must finalize the batch clock.
(define-public (jing-take (amount uint) (update (buff 8192)))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (try! (check-amount amount))
    (let ((limit (floor-of (try! (current-mid update)))))
      (let ((result (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
          (try! (contract-call? JING_MARKET swap amount limit update
            SBTC_TOKEN ASSET_SBTC WSTX_TOKEN ASSET_WSTX true))))))
        (ok (print { notification: "jing-take", payload: {
          amount: amount, limit-price: limit, out: (get token-y-received result),
        } }))))))

(define-public (router-swap
    (amount uint)
    (update (buff 8192))
  )
  (let (
      (mid (try! (current-mid update)))
      (limit (floor-of mid))
      (min-out (floor-out amount limit))
      (mins (contract-call? JING_MARKET get-min-deposits))
    )
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (asserts! (<= amount (var-get max-chunk-sats)) ERR_CHUNK_TOO_BIG)
    (try! (check-amount amount))
    (try! (cooldown-tick))
    (let ((result (try! (as-contract?
        ((with-ft SBTC_TOKEN ASSET_SBTC (+ amount (get min-token-x mins))))
        (try! (contract-call? JING_ROUTER smart-swap-sbtc-for-stx amount limit
          (some update) mid min-out
        ))
      ))))
      (ok (print { notification: "router-swap", payload: {
        amount: amount, limit-price: limit, mid: mid,
        out: (get out result), unsold: (get unsold result),
      } }))
    )
  )
)

;; Explicit venue allocation is reserved for the pool admin.
(define-public (router-swap-split
    (amount uint)
    (jing uint)
    (dlmm uint)
    (xyk uint)
    (velar uint)
    (update (buff 8192))
  )
  (let (
      (mid (try! (current-mid update)))
      (limit (floor-of mid))
      (velar-limit (/ (* mid (- BPS_PRECISION VELAR_SLIPPAGE_BPS)) BPS_PRECISION))
      (mins {
        dlmm: (floor-out dlmm limit),
        xyk: (floor-out xyk limit),
        velar: (floor-out velar velar-limit),
      })
      (market-mins (contract-call? JING_MARKET get-min-deposits))
    )
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (is-eq amount (+ jing dlmm xyk velar)) ERR_SPLIT_MISMATCH)
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (asserts! (<= amount (var-get max-chunk-sats)) ERR_CHUNK_TOO_BIG)
    (try! (check-amount amount))
    (try! (cooldown-tick))
    (let ((result (try! (as-contract?
        ((with-ft SBTC_TOKEN ASSET_SBTC (+ amount (get min-token-x market-mins))))
        (try! (contract-call? JING_ROUTER swap-sbtc-for-stx amount jing limit
          (some update) none { dlmm: dlmm, xyk: xyk, velar: velar } mins
          (+ (floor-out (+ jing dlmm xyk) limit) (floor-out velar velar-limit))
        ))
      ))))
      (ok (print { notification: "router-swap-split", payload: {
        amount: amount, jing: jing, dlmm: dlmm, xyk: xyk, velar: velar, limit-price: limit, velar-limit: velar-limit, mid: mid,
        out: (get out result), unsold: (get unsold result),
      } }))
    )
  )
)

(define-read-only (get-dia-value (key (string-ascii 32)))
  (let (
      (res (unwrap! (contract-call?
        'SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle get-value key)
        ERR_ORACLE_DIA))
      ;; "now" = the previous block's timestamp (the current block has none yet)
      (last-time (unwrap! (get-stacks-block-info? time (- stacks-block-height u1)) ERR_NO_BLOCK_TIME))
      (ts (/ (get timestamp res) u1000))
      (v (get value res))
    )
    (asserts! (> v u0) ERR_INVALID_PRICE)
    (asserts! (>= (+ ts MAX_DIA_AGE) last-time) ERR_ORACLE_STALE)
    (ok v)
  )
)

(define-read-only (get-dia-price)
  (let (
      (stx-usd (try! (get-dia-value "STX/USD")))
      (btc-usd (try! (get-dia-value "BTC/USD")))
      (price (/ (* btc-usd PRICE_PRECISION) stx-usd))
    )
    (asserts! (> price u0) ERR_INVALID_PRICE)
    (ok price)
  )
)

(define-read-only (window-open)
  (match (var-get batch-start)
    s (< burn-block-height (+ s (var-get window-blocks)))
    false
  )
)

(define-read-only (window-elapsed)
  (match (var-get batch-start)
    s (>= burn-block-height (+ s (var-get window-blocks)))
    false
  )
)

(define-private (sbtc-balance)
  (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract))
)

(define-private (current-mid (update (buff 8192)))
  (let (
      (mid (try! (contract-call? JING_MARKET refresh-mid update)))
      (band (var-get dia-band-bps))
    )
    (asserts! (> mid u0) ERR_INVALID_PRICE)
    (if (> band u0)
      (let ((dia (try! (get-dia-price))))
        (asserts! (>= (* mid BPS_PRECISION) (* dia (- BPS_PRECISION band))) ERR_ORACLE_DIVERGED)
        (asserts! (<= (* mid BPS_PRECISION) (* dia (+ BPS_PRECISION band))) ERR_ORACLE_DIVERGED)
        (ok mid)
      )
      (ok mid)
    )
  )
)

(define-private (ask-of (mid uint))
  (/ (* mid (- BPS_PRECISION (var-get leeway-bps))) BPS_PRECISION)
)

(define-private (floor-of (mid uint))
  (/ (* mid (- BPS_PRECISION (var-get slippage-bps))) BPS_PRECISION)
)

(define-private (floor-out (amount uint) (limit uint))
  (/ (* amount limit) (* PRICE_PRECISION DECIMAL_FACTOR))
)

(define-private (cooldown-tick)
  (begin
    (asserts! (>= burn-block-height (+ (var-get last-router-swap) (var-get router-cooldown-blocks))) ERR_COOLDOWN)
    (ok (var-set last-router-swap burn-block-height))
  )
)

(define-private (check-amount (amount uint))
  (begin
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (asserts! (<= amount (sbtc-balance)) ERR_NO_FUNDS)
    (ok true)
  )
)

(define-private (reclaim-core)
  (let ((refunded (try! (as-contract? ()
      (try! (contract-call? JING_MARKET cancel-token-x-deposit SBTC_TOKEN ASSET_SBTC))
    ))))
    (ok (print { notification: "jing-reclaim", payload: { amount: refunded } }))
  )
)

(define-read-only (get-clock)
  (let ((start (var-get batch-start)))
    {
      batch-start: start,
      window-ends: (match start
        s (some (+ s (var-get window-blocks)))
        none
      ),
      window-open: (window-open),
      window-elapsed: (window-elapsed),
      burn-height: burn-block-height,
    }
  )
)

(define-read-only (is-empty)
  (let ((cycle (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6 get-current-cycle)))
    (and
      (is-eq (sbtc-balance) u0)
      (is-eq (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6 get-token-x-deposit cycle current-contract) u0)
      (is-eq (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6 get-token-x-parked current-contract) u0)
    )
  )
)

;; Pool admin may reset the guard if the market fell below the maker floor.
;; This changes the guard; the zero-spread peg still executes at verified mid.
(define-public (jing-refloor (update (buff 8192)))
  (let ((mid (try! (current-mid update)))
        (floor (if (window-open) (ask-of mid) (floor-of mid))))
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (try! (as-contract? ()
      (try! (contract-call? JING_MARKET set-token-x-limit floor (some u0) update))))
    (ok floor)))

(define-read-only (get-config)
 { pool: POOL, window-blocks: (var-get window-blocks),
   leeway-bps: (var-get leeway-bps), slippage-bps: (var-get slippage-bps),
   max-chunk-sats: (var-get max-chunk-sats), dia-band-bps: (var-get dia-band-bps),
   router-cooldown-blocks: (var-get router-cooldown-blocks),
   last-router-swap: (var-get last-router-swap),
   market: JING_MARKET, router: JING_ROUTER })
