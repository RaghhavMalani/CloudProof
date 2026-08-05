/**
 * Index artifacts and secrets.
 *
 * S3 holds the FAISS shards and the model manifest. The consensus log holds
 * *pointers* to them — a key like `model/current` whose value is an S3 key and
 * a checksum. That split is deliberate: consensus is for small, ordered,
 * agreed-upon facts, and a 400MB index file is none of those things. Putting
 * the artifact in S3 and the agreement in Raft keeps the log small enough to
 * fsync on every append.
 */

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "${local.name}-artifacts-${random_id.bucket_suffix.hex}"

  tags = merge(local.tags, { Name = "${local.name}-artifacts" })
}

# Versioning is what makes the atomic rollout demo honest. Flipping
# `model/current` through consensus points every pod at a new key; if the new
# index is bad, the previous version is still there and the rollback is another
# CAS rather than a restore.
resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-old-index-versions"
    status = "Enabled"

    filter {
      prefix = "index/"
    }

    # Keep enough history to roll back, not enough to pay for every build ever.
    noncurrent_version_expiration {
      noncurrent_days = 14
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 3
    }
  }
}

resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/app"
  description = "Application secrets for the miniRaft serving tier."

  # A lab cluster gets destroyed and rebuilt often, and the default 30-day
  # recovery window means the name stays reserved and the next apply fails.
  recovery_window_in_days = 0

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    placeholder = "replace via the console or a separate pipeline; do not commit real values to state"
  })

  lifecycle {
    # Terraform state is not the right home for rotated secrets. Ignoring
    # changes lets something else own the value after the initial create.
    ignore_changes = [secret_string]
  }
}
