output "cluster_name" {
  description = "EKS cluster name."
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = module.eks.cluster_endpoint
}

output "configure_kubectl" {
  description = "Command to point kubectl at this cluster."
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

output "artifacts_bucket" {
  description = "S3 bucket holding index artifacts and the model manifest."
  value       = aws_s3_bucket.artifacts.id
}

output "serving_role_arn" {
  description = "IRSA role assumed by the embedding service account."
  value       = module.serving_irsa.iam_role_arn
}

output "indexer_role_arn" {
  description = "IRSA role for the index build pipeline."
  value       = module.indexer_irsa.iam_role_arn
}

output "app_secret_arn" {
  description = "Secrets Manager secret for the serving tier."
  value       = aws_secretsmanager_secret.app.arn
}

output "consensus_node_selector" {
  description = "Node selector and toleration the Raft StatefulSet must carry."
  value = {
    nodeSelector = { "cloudproof.io/tier" = "consensus" }
    toleration   = "cloudproof.io/tier=consensus:NoSchedule"
  }
}

output "fixed_monthly_cost_floor_usd" {
  description = <<-EOT
    Rough always-on cost, before a single query is served. This is the number
    the cost-per-thousand-queries curve amortises against, and the reason that
    curve is interesting: the consensus tier bills whether or not anyone is
    querying, so cost per thousand falls steeply with QPS until the variable
    serving cost dominates. List prices, on-demand, ap-south-1 — verify against
    the AWS pricing pages before quoting these.
  EOT

  value = {
    eks_control_plane = 73
    system_nodes      = var.system_node_count * 15
    consensus_nodes   = var.consensus_node_count * 15
    ebs_volumes       = var.consensus_node_count * var.consensus_volume_size * 0.09
    nat_gateway       = var.enable_nat_gateway ? (var.single_nat_gateway ? 32 : 32 * var.availability_zone_count) : 0
    note              = "Serving-tier Fargate cost is variable and excluded; that is the point of the split."
  }
}
