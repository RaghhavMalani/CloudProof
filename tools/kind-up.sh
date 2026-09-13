#!/usr/bin/env bash
#
# kind-up.sh — the whole system on a real Kubernetes cluster, for free.
#
# Everything here runs on your machine: kind is Kubernetes in Docker containers,
# MinIO is S3, and the images are built locally and side-loaded, so no registry
# and no cloud account are involved.
#
# What this proves that `node tools/demo-up.js` does not:
#   - the StatefulSet actually schedules, with PVCs bound and stable DNS
#   - the consensus taint and toleration work — pods land where intended
#   - required pod anti-affinity is satisfiable across three separate nodes
#   - the AWS SDK path is exercised for real against an S3-compatible endpoint
#   - readiness gating genuinely keeps unready pods out of the Service
#
# What it still cannot prove:
#   - IRSA. There is no IAM in kind, so credentials come from a Secret. This is
#     the single largest gap between here and EKS.
#   - Fargate cold starts, scale-to-zero and per-pod billing.
#   - real EBS behaviour, including the zonal constraint on volume attachment.
#
#   ./tools/kind-up.sh          bring it up
#   ./tools/kind-up.sh --down   tear it down
set -euo pipefail

CLUSTER=miniraft
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_SERVING=miniraft-embedding:local
IMAGE_REPLICA=miniraft-replica:local
IMAGE_GATEWAY=miniraft-gateway:local
KEDA_VERSION="${KEDA_VERSION:-2.16.0}"

if [[ "${1:-}" == "--down" ]]; then
  kind delete cluster --name "$CLUSTER"
  echo "cluster deleted."
  exit 0
fi

for tool in docker kind kubectl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing: $tool"; exit 1; }
done

echo "==> creating cluster (4 nodes: 1 system, 3 consensus)"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "    already exists, reusing"
else
  kind create cluster --config "$ROOT/k8s/local/kind-cluster.yaml"
fi

echo "==> building images (first run pulls base layers; give it a few minutes)"
# Build contexts differ per image and are not interchangeable: replica/Dockerfile
# does `COPY package.json` and needs the replica directory as its context, while
# gateway/Dockerfile does `COPY gateway/package.json` and needs the repo root.
docker build -f "$ROOT/Dockerfile.serving" -t "$IMAGE_SERVING" "$ROOT"
docker build -f "$ROOT/replica/Dockerfile" -t "$IMAGE_REPLICA" "$ROOT/replica"
# The gateway is not used by the dashboard demo, but k8s/miniraft.yaml deploys
# it. Skipping the build leaves a pod in ImagePullBackOff trying to reach a
# registry that has never been pushed to — which looks like a cluster fault
# rather than a missing build step.
docker build -f "$ROOT/gateway/Dockerfile" -t "$IMAGE_GATEWAY" "$ROOT"

# Side-loading beats running a registry: no extra service, no push, and the
# nodes get exactly the bytes that were just built.
echo "==> loading images into the cluster"
kind load docker-image "$IMAGE_SERVING" "$IMAGE_REPLICA" "$IMAGE_GATEWAY" --name "$CLUSTER"

echo "==> deploying MinIO and seeding artifacts"
kubectl apply -f "$ROOT/k8s/local/minio.yaml"
kubectl -n minio rollout status deploy/minio --timeout=120s
kubectl -n minio wait --for=condition=complete job/seed-artifacts --timeout=180s

echo "==> deploying the consensus tier"
# The base manifest pins gp3 and a registry image; kind has neither. `standard`
# is kind's default StorageClass, backed by local-path-provisioner.
sed -e "s|storageClassName: gp3|storageClassName: standard|" \
    -e "s|image: ghcr.io/raghhavmalani/miniraft-replica:latest|image: ${IMAGE_REPLICA}|" \
    -e "s|image: ghcr.io/raghhavmalani/miniraft-gateway:latest|image: ${IMAGE_GATEWAY}|" \
    -e "s|imagePullPolicy: Always|imagePullPolicy: IfNotPresent|" \
    "$ROOT/k8s/miniraft.yaml" | kubectl apply -f -

echo "    waiting for a quorum to form..."
kubectl -n miniraft rollout status statefulset/raft --timeout=240s

echo "==> deploying the serving tier"
kubectl apply -f "$ROOT/k8s/local/serving-local.yaml"
kubectl -n miniraft-serving rollout status statefulset/embedding --timeout=180s || true
kubectl -n miniraft-serving rollout status deploy/dashboard --timeout=120s

echo "==> deploying Prometheus and Grafana"
kubectl apply -f "$ROOT/k8s/local/monitoring.yaml"
kubectl -n monitoring rollout status deploy/prometheus --timeout=120s
kubectl -n monitoring rollout status deploy/grafana --timeout=120s

echo "==> installing KEDA"
# Server-side apply: the KEDA bundle contains CRDs large enough to blow the
# client-side annotation size limit, which fails with a confusing
# "metadata.annotations: Too long" rather than anything about CRDs.
if kubectl get crd scaledobjects.keda.sh >/dev/null 2>&1; then
  echo "    already installed"
else
  kubectl apply --server-side -f \
    "https://github.com/kedacore/keda/releases/download/v${KEDA_VERSION}/keda-${KEDA_VERSION}.yaml"
  kubectl -n keda rollout status deploy/keda-operator --timeout=180s
  # The metrics apiservice takes a few seconds beyond the deployment being
  # ready; applying a ScaledObject before then fails validation.
  kubectl -n keda rollout status deploy/keda-operator-metrics-apiserver --timeout=180s
fi
kubectl apply -f "$ROOT/k8s/local/keda.yaml"

echo "==> publishing v1"
# The Job ships in serving-local.yaml and has already been applied; just wait
# for it. It stages the manifest, waits for all three pods to preload, then
# flips model/current.
kubectl -n miniraft-serving wait --for=condition=complete job/publish-v1 --timeout=240s \
  || { echo "    rollout did not complete — kubectl -n miniraft-serving logs job/publish-v1"; }

cat <<EOF

  ┌────────────────────────────────────────────────────────┐
  │  miniRaft is running on Kubernetes.  Cost: \$0.         │
  │                                                        │
  │    dashboard   http://localhost:8080                   │
  │    Grafana     http://localhost:3000                   │
  │    MinIO       http://localhost:9090                   │
  │                (miniraft / miniraft-local-dev)         │
  │                                                        │
  │  Worth looking at:                                     │
  │    kubectl get pods -A -o wide                         │
  │      → raft-0/1/2 each on a different consensus node   │
  │    kubectl -n miniraft delete pod raft-0               │
  │      → watch the PVC survive and the log recover       │
  │    kubectl describe node -l miniraft.io/tier=consensus │
  │      → the taint that keeps serving pods off           │
  │                                                        │
  │  Autoscaling demo:                                     │
  │    node tools/loadgen.js --targets http://localhost:8080│
  │    kubectl -n miniraft-serving get hpa -w              │
  │                                                        │
  │  CloudProof sim-to-real replay:                        │
  │    node tools/cloudproof-kind-replay.js <artifact>     │
  │                                                        │
  │  ./tools/kind-up.sh --down   to remove everything      │
  └────────────────────────────────────────────────────────┘

EOF
