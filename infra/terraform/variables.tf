# ── cost guard ───────────────────────────────────────────────────────────────
#
# Everything else in this repository is free: kind gives a real Kubernetes
# cluster, MinIO gives S3, Prometheus and Grafana and KEDA are open source, and
# it all runs on a laptop. This directory is the sole exception, and applying it
# starts billing immediately — the EKS control plane alone is roughly $73/month
# and has no free tier, so a forgotten cluster is a real and recurring charge.
#
# A comment is not a safeguard. This variable is: `terraform apply` fails
# validation until it is deliberately set, so the billable path cannot be
# entered by muscle memory or by a CI job that runs apply on every push.
#
#   terraform apply -var acknowledge_aws_costs=true
#
# The manifests in k8s/ are the same ones the free local cluster runs, so this
# directory is worth more as code an interviewer reads than as infrastructure
# anyone pays for. If you do apply it, capture what you need and run
# `terraform destroy` the same day.
variable "acknowledge_aws_costs" {
  description = "Must be true to apply. Guards against accidentally provisioning billable AWS infrastructure."
  type        = bool
  default     = false

  validation {
    condition     = var.acknowledge_aws_costs
    error_message = <<-EOT
      Refusing to apply: this configuration provisions billable AWS resources
      (~$174/month at idle, of which ~$73 is the EKS control plane, which has no
      free tier).

      The free equivalent runs locally and proves most of the same things:
        ./tools/kind-up.sh

      To proceed anyway, set the flag explicitly:
        terraform apply -var acknowledge_aws_costs=true

      Then destroy it when you are done:
        terraform destroy -var acknowledge_aws_costs=true
    EOT
  }
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Environment name, used in resource names and tags."
  type        = string
  default     = "dev"
}

variable "cluster_name" {
  description = "EKS cluster name."
  type        = string
  default     = "cloudproof"
}

variable "kubernetes_version" {
  description = "EKS control plane version."
  type        = string
  default     = "1.30"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "availability_zone_count" {
  description = <<-EOT
    Number of AZs to spread across. Three is the minimum that lets the Raft
    cluster survive an AZ failure: with three replicas in three zones, losing a
    zone leaves a two-node majority. Two zones would mean a zone failure can
    take out the quorum, which defeats the point of running consensus.
  EOT
  type        = number
  default     = 3

  validation {
    condition     = var.availability_zone_count >= 3
    error_message = "The consensus tier needs at least three availability zones to keep quorum through a zone failure."
  }
}

# ── consensus tier ───────────────────────────────────────────────────────────

variable "consensus_instance_type" {
  description = "Instance type for the nodes running the Raft StatefulSet."
  type        = string
  default     = "t3.small"
}

variable "consensus_node_count" {
  description = <<-EOT
    Nodes in the consensus group. One per Raft replica: the StatefulSet uses
    pod anti-affinity, so two replicas sharing a node would make that node a
    single point of failure for a majority.
  EOT
  type        = number
  default     = 3
}

variable "consensus_volume_size" {
  description = "gp3 volume size (GiB) for each Raft replica's log."
  type        = number
  default     = 10
}

# ── system tier ──────────────────────────────────────────────────────────────

variable "system_instance_type" {
  description = "Instance type for cluster add-ons (CoreDNS, EBS CSI controller, KEDA)."
  type        = string
  default     = "t3.small"
}

variable "system_node_count" {
  description = <<-EOT
    Nodes for cluster add-ons. This group exists because the consensus group is
    tainted: CoreDNS and the EBS CSI controller are Deployments, not
    DaemonSets, and will not tolerate a custom taint. Without somewhere
    untainted to land, DNS never becomes ready and the cluster is inert.
  EOT
  type        = number
  default     = 1
}

# ── serving tier ─────────────────────────────────────────────────────────────

variable "serving_namespace" {
  description = "Namespace whose pods are scheduled onto Fargate."
  type        = string
  default     = "cloudproof-serving"
}

variable "consensus_namespace" {
  description = "Namespace for the Raft StatefulSet and gateway."
  type        = string
  default     = "cloudproof-raft"
}

variable "enable_nat_gateway" {
  description = <<-EOT
    Fargate tasks and private nodes need outbound internet to pull images.
    A NAT gateway is the largest single line item in the fixed cost floor
    (~$32/month plus data processing), so it is a variable rather than an
    assumption — see infra/terraform/README.md for the cost breakdown that
    feeds the cost-per-thousand-queries curve.
  EOT
  type        = bool
  default     = true
}

variable "single_nat_gateway" {
  description = "Use one NAT gateway for all AZs. Cheaper, but a zonal SPOF for egress."
  type        = bool
  default     = true
}
