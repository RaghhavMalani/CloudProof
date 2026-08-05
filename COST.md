# Cost

**This project costs $0 to build, run and demonstrate.**

Everything runs on your machine. There is no cloud account, no card, no free
trial to forget to cancel. The one directory that could ever charge you refuses
to run without an explicit flag.

## What runs, and what it costs

| Component | Stands in for | Cost |
|---|---|---|
| kind (Kubernetes in Docker) | EKS | $0 |
| MinIO | S3 | $0 |
| local-path-provisioner | EBS / gp3 | $0 |
| Prometheus + Grafana | CloudWatch / AMP | $0 |
| KEDA | KEDA on EKS (same software) | $0 |
| Redis | ElastiCache | $0 |
| Cloudflare quick tunnel | ALB + Route 53 | $0 |
| Docker images built locally, `kind load` | ECR | $0 |

The only real resource consumed is your laptop: roughly 4GB of RAM and 6GB of
disk with the full cluster up. `./tools/kind-up.sh --down` returns all of it.

## Three ways to run it, all free

```bash
node tools/demo-up.js              # bare processes, ~5s to start, nothing to install
node tools/demo-up.js --tunnel     # same, plus a temporary public URL
./tools/kind-up.sh                 # real Kubernetes, ~3min, needs Docker
```

The first is for iterating. The third is for demonstrating, because it proves
things the first cannot: that the StatefulSet schedules with bound volumes, that
the consensus taint keeps serving pods off those nodes, that required pod
anti-affinity is satisfiable, that the AWS SDK path works against a real
S3-compatible endpoint, and that KEDA scales on p99 latency.

## The one thing that costs money

`infra/terraform/` provisions real AWS infrastructure: EKS, managed node groups,
a Fargate profile, NAT, S3 and Secrets Manager. Roughly **$174/month at idle**,
of which ~$73 is the EKS control plane — which has **no free tier**, so it bills
from the minute the cluster exists whether or not anything is deployed on it.

It cannot be applied by accident:

```
$ terraform apply
Error: Invalid value for variable

  Refusing to apply: this configuration provisions billable AWS resources
  (~$174/month at idle, of which ~$73 is the EKS control plane, which has no
  free tier).

  The free equivalent runs locally and proves most of the same things:
    ./tools/kind-up.sh
```

That guard is a `validation` block on `var.acknowledge_aws_costs`, so it fails
at plan time rather than after resources exist — and it survives a CI job that
runs `terraform apply` on every push, which a comment in a README would not.

**Keep it as reference code.** The Terraform is worth more as something an
interviewer reads than as infrastructure anyone pays for: it shows the split-tier
reasoning, the taint that forces a separate system node group, the IRSA roles
split between read and write. None of that requires it to be running. If you do
want screenshots, apply it, capture them, and `terraform destroy` the same day —
a few dollars, not a monthly bill.

## What the free stack cannot prove

Worth stating plainly rather than implying the local run covers everything:

- **IRSA.** There is no IAM in kind, so MinIO credentials come from a Secret.
  This is the largest single gap. The code path differs by exactly one thing:
  whether `credentials` is passed to the S3 client or left for the SDK to
  resolve from the projected service-account token.
- **Fargate.** Scale-to-zero, per-pod billing and genuine sandbox cold starts
  have no local equivalent. Cold-start numbers measured against kind and MinIO
  are a floor, not a forecast.
- **EBS zonal behaviour.** local-path-provisioner has no notion of availability
  zones, so the constraint that a pod can only reschedule onto a node in its
  volume's AZ is never exercised.
- **Real S3 latency and durability.** MinIO on the same machine reproduces the
  API, not the network.

Everything else — consensus, persistence, leases, CAS, watch, the two-phase
rollout, readiness gating, taints, anti-affinity, autoscaling on p99 — is
genuinely exercised.
