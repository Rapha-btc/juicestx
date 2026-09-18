;; Test-copy adapter only when these uncommitted methods are missing.
(define-public (set-vault-no-pyth-slippage-bps (bps uint))
  (begin
    (try! (assert-admin))
    (contract-call? SWAP_VAULT set-no-pyth-slippage-bps bps)))

(define-public (router-swap-split-dia
    (amount uint) (dlmm uint) (xyk uint) (velar uint))
  (begin
    (try! (assert-admin))
    (contract-call? SWAP_VAULT router-swap-split-dia amount dlmm xyk velar)))
