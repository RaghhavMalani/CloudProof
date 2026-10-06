# Durability gate

| window | profile | runs (kills in window) | acknowledged | recovered acknowledged | missing acknowledged | duplicate logical writes | in-doubt retried → acked once | unacknowledged recovered / unacknowledged | committed prefixes identical | pass |
|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|:---:|
| before group flush | group-commit | 5 (5) | 28710 | 28710 | 0 | 0 | 60 | 26 / 60 | yes | PASS |
| after flush / before quorum | group-commit | 5 (5) | 21692 | 21692 | 0 | 0 | 60 | 17 / 60 | yes | PASS |
| after commit / before client reply | optimized-http | 5 (5) | 13123 | 13123 | 0 | 0 | 60 | 33 / 60 | yes | PASS |
| during pipelined replication | group-pipeline | 5 (5) | 9955 | 9955 | 0 | 0 | 60 | 39 / 60 | yes | PASS |
| during batched replication | group-batch | 5 (5) | 15705 | 15705 | 0 | 0 | 60 | 24 / 59 | yes | PASS |
| binary transport active | optimized-binary | 5 (5) | 16472 | 16472 | 0 | 0 | 60 | 33 / 60 | yes | PASS |

Gate: PASS
