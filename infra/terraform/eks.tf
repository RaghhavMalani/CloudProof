/**
 * The split-tier cluster.
 *
 * One control plane, one Terraform state, two very different compute models:
 *
 *   consensus tier — managed node groups, real EC2 instances with EBS volumes.
 *     The Raft StatefulSet lives here because it needs three things Fargate
 *     cannot provide: a persistent volume that survives a pod restart, a stable
 *     network identity so peers can find each other, and a long-lived process
 *     that can hold election timers. The nodes are tainted so nothing else
 *     drifts onto them.
 *
 *   serving tier — a Fargate profile. The embedding pods are stateless, so they
 *     get per-pod billing, scale-to-zero, and genuine cold starts. Those cold
 *     starts are a feature: measuring image pull, model load, and shard fetch
 *     separately is only possible on a platform that actually starts cold.
 *
 * The alternative designs both lose something. All-Fargate cannot run the
 * StatefulSet at all. All-EC2 gives up per-pod billing and the cold-start
 * measurement, and leaves idle capacity paid for around the clock.
 */

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.24"

  cluster_name    = local.name
  cluster_version = var.kubernetes_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # Public endpoint keeps `kubectl` usable from a laptop without a bastion.
  # Restrict cluster_endpoint_public_access_cidrs before this is anything but a
  # lab cluster.
  cluster_endpoint_public_access  = true
  cluster_endpoint_private_access = true

  enable_irsa = true

  # The identity that runs `terraform apply` gets cluster-admin. Without this
  # the cluster comes up and nobody can talk to it.
  enable_cluster_creator_admin_permissions = true

  cluster_addons = {
    coredns = {
      most_recent = true
      # CoreDNS is a Deployment. It cannot tolerate the consensus taint, which
      # is exactly why the system node group exists.
      configuration_values = jsonencode({
        nodeSelector = { "cloudproof.io/tier" = "system" }
      })
    }
    kube-proxy = { most_recent = true }
    vpc-cni = {
      most_recent    = true
      before_compute = true
      configuration_values = jsonencode({
        env = { ENABLE_PREFIX_DELEGATION = "true" }
      })
    }
    aws-ebs-csi-driver = {
      most_recent              = true
      service_account_role_arn = module.ebs_csi_irsa.iam_role_arn
      configuration_values = jsonencode({
        controller = {
          nodeSelector = { "cloudproof.io/tier" = "system" }
        }
      })
    }
  }

  eks_managed_node_groups = {
    # ── system ───────────────────────────────────────────────────────────────
    system = {
      name           = "system"
      instance_types = [var.system_instance_type]
      min_size       = 1
      max_size       = 2
      desired_size   = var.system_node_count

      labels = {
        "cloudproof.io/tier" = "system"
      }
    }

    # ── consensus ────────────────────────────────────────────────────────────
    consensus = {
      name           = "consensus"
      instance_types = [var.consensus_instance_type]
      min_size       = var.consensus_node_count
      max_size       = var.consensus_node_count
      desired_size   = var.consensus_node_count

      # Deliberately not spot. A spot reclaim is a node disappearing with two
      # minutes' notice; doing that to a Raft member costs an election and, if
      # two go at once, the quorum. The serving tier is where interruptible
      # capacity belongs.
      capacity_type = "ON_DEMAND"

      labels = {
        "cloudproof.io/tier" = "consensus"
      }

      taints = {
        consensus = {
          key    = "cloudproof.io/tier"
          value  = "consensus"
          effect = "NO_SCHEDULE"
        }
      }

      # EBS volumes are zonal. A pod whose PVC lives in ap-south-1a can only be
      # rescheduled onto a node in ap-south-1a, so the group must span the same
      # AZs as the subnets.
      subnet_ids = module.vpc.private_subnets

      block_device_mappings = {
        root = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size           = 20
            volume_type           = "gp3"
            encrypted             = true
            delete_on_termination = true
          }
        }
      }
    }
  }

  # ── serving tier ─────────────────────────────────────────────────────────
  fargate_profiles = {
    serving = {
      name = "serving"
      selectors = [
        {
          namespace = var.serving_namespace
          labels    = { "cloudproof.io/tier" = "serving" }
        }
      ]
      # Fargate is private-subnet only.
      subnet_ids = module.vpc.private_subnets
    }
  }

  tags = local.tags
}

# gp3 rather than the default gp2: cheaper per GiB, and baseline IOPS are not
# tied to volume size. The Raft log is fsync-heavy and small, which is the worst
# case for gp2's size-linked performance.
#
# Deliberately *not* annotated as the default class. EKS ships its own `gp2`
# StorageClass already marked default, and a cluster with two defaults resolves
# unqualified PVCs arbitrarily. The StatefulSet names `gp3` explicitly instead,
# which is clearer anyway: the volume the consensus log lives on is not
# something to leave to a cluster-wide default.
resource "kubernetes_storage_class_v1" "gp3" {
  metadata {
    name = "gp3"
  }

  storage_provisioner    = "ebs.csi.aws.com"
  reclaim_policy         = "Retain"
  allow_volume_expansion = true

  # The volume must not be created until the scheduler has picked a node, or
  # EBS may provision it in an AZ the pod cannot reach.
  volume_binding_mode = "WaitForFirstConsumer"

  parameters = {
    type      = "gp3"
    encrypted = "true"
    fsType    = "ext4"
  }

  depends_on = [module.eks]
}

resource "kubernetes_namespace_v1" "serving" {
  metadata {
    name   = var.serving_namespace
    labels = { "cloudproof.io/tier" = "serving" }
  }

  depends_on = [module.eks]
}
