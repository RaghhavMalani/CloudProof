# Durability gate

| window | profile | runs (kills in window) | acknowledged | recovered acknowledged | missing acknowledged | duplicate logical writes | in-doubt retried → acked once | unacknowledged recovered / unacknowledged | committed prefixes identical | pass |
|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|:---:|
| before group flush | group-commit | 5 (5) | 28985 | 28985 | 0 | 0 | 60 | 27 / 60 | yes | PASS |
| after flush / before quorum | group-commit | 5 (5) | 28439 | 28439 | 0 | 0 | 60 | 21 / 60 | yes | PASS |
| after commit / before client reply | optimized-http | 5 (5) | 22663 | 22663 | 0 | 0 | 60 | 31 / 60 | yes | PASS |
| during pipelined replication | group-pipeline | 5 (5) | 17251 | 17251 | 0 | 0 | 60 | 30 / 60 | yes | PASS |
| during batched replication | group-batch | 5 (5) | 29630 | 29630 | 0 | 0 | 60 | 15 / 60 | yes | PASS |
| binary transport active | optimized-binary | 5 (5) | 30820 | 30820 | 0 | 0 | 60 | 24 / 60 | yes | PASS |

Gate: PASS
