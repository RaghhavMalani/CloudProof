locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.availability_zone_count)

  name = "${var.cluster_name}-${var.environment}"

  # Fargate pods only run in private subnets — they have no public IP and reach
  # the internet through NAT. This is not a preference, it is a constraint of
  # the platform, and it is the reason the serving tier still needs a VPC even
  # though it has no nodes.
  tags = {
    Cluster = local.name
  }
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.8"

  name = local.name
  cidr = var.vpc_cidr
  azs  = local.azs

  private_subnets = [for i in range(var.availability_zone_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets  = [for i in range(var.availability_zone_count) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  enable_nat_gateway   = var.enable_nat_gateway
  single_nat_gateway   = var.single_nat_gateway
  enable_dns_hostnames = true
  enable_dns_support   = true

  # The load balancer controller discovers subnets by these tags.
  public_subnet_tags = {
    "kubernetes.io/role/elb"                    = 1
    "kubernetes.io/cluster/${local.name}"       = "shared"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"           = 1
    "kubernetes.io/cluster/${local.name}"       = "shared"
  }

  tags = local.tags
}

# S3 traffic is the hot path for index shards: every serving pod pulls its
# shard from S3 on cold start. A gateway endpoint keeps that traffic off the
# NAT gateway, which removes both the per-GB NAT processing charge and a
# bandwidth bottleneck during a mass cold start.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.vpc.private_route_table_ids

  tags = merge(local.tags, { Name = "${local.name}-s3" })
}
