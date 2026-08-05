# miniRaft infrastructure

Split-tier EKS: one cluster, one Terraform state, two compute models chosen for
what each tier actually needs.

## Why split

| | consensus tier | serving tier |
|---|---|---|
| runs | Raft StatefulSet, gateway | embedding pods |
| compute | EKS managed node groups (EC2) | EKS Fargate profile |
| storage | gp3 EBS via `volumeClaimTemplates` | none — pulls shards from S3 |
| billing | per node, always on | per pod, scale to zero |
| why | persistent volume, stable identity, long-lived election timers | cold starts and per-query cost are measurable |

Neither single-platform option works. All-Fargate cannot run the StatefulSet at
all — no EBS, no stable identity, no long-lived process. All-EC2 gives up
per-pod billing and, more importantly, gives up the ability to measure a
genuine cold start, since nothing ever actually starts cold.

The taint is what keeps the split honest. Consensus nodes carry
`miniraft.io/tier=consensus:NoSchedule`, so only pods that explicitly tolerate
it land there. That in turn forces a small untainted `system` node group,
because CoreDNS and the EBS CSI controller are Deployments, not DaemonSets, and
will not tolerate a custom taint — without somewhere untainted to land, DNS
never goes ready and the cluster is inert.

## Apply

```bash
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
terraform apply tfplan
aws eks update-kubeconfig --region ap-south-1 --name miniraft-dev
kubectl apply -f ../../k8s/miniraft.yaml
```

`fixed_monthly_cost_floor_usd` in the outputs is the always-on cost before a
single query is served. It is the denominator the cost-per-thousand-queries
curve amortises against — the consensus tier bills whether or not anyone is
querying, so cost per thousand falls steeply with QPS until variable serving
cost dominates. The crossover against a managed vector store is the interesting
point on that chart.

Destroy note: the artifacts bucket has versioning on, so `terraform destroy`
will fail until object versions are cleared. That is deliberate — an index
bucket that empties itself on a stray destroy is worse than one that complains.

## What about Vercel?

The frontend can go on Vercel today; it is static. Nothing else can.

The gateway holds WebSocket connections, an in-memory client set and a polling
loop. Vercel functions are ephemeral and cannot hold a long-lived socket
server. Reworking it to SSE plus Redis pub/sub would make it *deployable*, but
it would still be a worse fit than a container.

The replicas cannot go there at all, and the reason is the same one that ruled
out a managed vector store: this project's value is that consensus is
load-bearing. Raft needs a durable disk that survives a restart, a stable
address so peers can find each other across elections, and a process that lives
long enough to hold an election timer. Serverless removes all three by design.
A Raft cluster on Vercel is not a hard build — it is a contradiction.

Worth saying out loud rather than hiding: the honest version of this trade is
"I know why serverless exists and where it stops," which is a better answer than
"I deployed to Vercel."

If you want a cheap always-on public demo before the EKS bill starts, Fly.io is
the closest fit — persistent volumes, private networking between machines, and
three machines in three regions maps almost exactly onto this topology. Render
and Railway both offer disks and would also work. A single small VM running the
existing `docker-compose.yml` is the cheapest option and demos identically.

## Files

| file | contents |
|---|---|
| `versions.tf` | provider constraints, S3 backend, kubernetes provider auth |
| `variables.tf` | tunables, with the AZ-count validation that protects quorum |
| `vpc.tf` | VPC, subnets, NAT, S3 gateway endpoint |
| `eks.tf` | cluster, both node groups, Fargate profile, addons, gp3 class |
| `storage.tf` | versioned artifacts bucket, lifecycle rules, Secrets Manager |
| `irsa.tf` | OIDC-bound roles: EBS CSI, serving read, indexer write |
| `outputs.tf` | kubeconfig command, ARNs, cost floor |

Serving pods read index artifacts through IRSA rather than a node instance
profile — partly for least privilege, but mostly because Fargate has no node
instance profile to attach anything to. The indexer's write role is separate
from the serving read role, so a compromised serving pod cannot poison the
index every other pod is about to load.
