/**
 * IRSA — IAM Roles for Service Accounts.
 *
 * The alternative is attaching S3 permissions to the node instance profile,
 * which grants them to every pod on the node including anything that gets
 * compromised. IRSA binds a role to a specific Kubernetes service account
 * through the cluster's OIDC provider, so the embedding pods can read index
 * artifacts and nothing else on the cluster can.
 *
 * It also happens to be the only credential mechanism that works on Fargate,
 * where there is no node instance profile to attach anything to.
 */

module "ebs_csi_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  role_name             = "${local.name}-ebs-csi"
  attach_ebs_csi_policy = true

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"]
    }
  }

  tags = local.tags
}

# ── serving tier: read index artifacts, read one secret ──────────────────────

data "aws_iam_policy_document" "serving" {
  statement {
    sid    = "ReadIndexArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]

    resources = ["${aws_s3_bucket.artifacts.arn}/*"]
  }

  statement {
    sid    = "ListArtifactBucket"
    effect = "Allow"

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]
  }

  statement {
    sid    = "ReadAppSecret"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    # Scoped to this one secret rather than the account's secrets.
    resources = [aws_secretsmanager_secret.app.arn]
  }
}

resource "aws_iam_policy" "serving" {
  name        = "${local.name}-serving"
  description = "Read-only access to miniRaft index artifacts and app secrets."
  policy      = data.aws_iam_policy_document.serving.json

  tags = local.tags
}

module "serving_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  role_name = "${local.name}-serving"

  role_policy_arns = {
    serving = aws_iam_policy.serving.arn
  }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["${var.serving_namespace}:embedding"]
    }
  }

  tags = local.tags
}

resource "kubernetes_service_account_v1" "embedding" {
  metadata {
    name      = "embedding"
    namespace = kubernetes_namespace_v1.serving.metadata[0].name

    annotations = {
      "eks.amazonaws.com/role-arn" = module.serving_irsa.iam_role_arn
    }
  }
}

# ── build pipeline: write index artifacts ────────────────────────────────────
# Separated from the read role on purpose. The pods that serve queries have no
# way to modify the index they serve, so a compromised serving pod cannot
# poison the artifacts every other pod is about to load.

data "aws_iam_policy_document" "indexer" {
  statement {
    sid    = "WriteIndexArtifacts"
    effect = "Allow"

    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:AbortMultipartUpload",
    ]

    resources = ["${aws_s3_bucket.artifacts.arn}/index/*"]
  }

  statement {
    sid       = "ListArtifactBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]
  }
}

resource "aws_iam_policy" "indexer" {
  name        = "${local.name}-indexer"
  description = "Write access to miniRaft index artifacts."
  policy      = data.aws_iam_policy_document.indexer.json

  tags = local.tags
}

module "indexer_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  role_name = "${local.name}-indexer"

  role_policy_arns = {
    indexer = aws_iam_policy.indexer.arn
  }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["${var.consensus_namespace}:indexer"]
    }
  }

  tags = local.tags
}
