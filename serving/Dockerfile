# Superseded by ../Dockerfile.serving.
#
# This file used to build the embedding service from the serving/ directory as
# its context. That stopped being viable once the dashboard and the artifact
# seed job started sharing the image: both live in tools/, which a serving/
# context cannot see, so an image built here starts the service correctly and
# then fails on `node tools/dashboard.js` with a missing file.
#
# Build from the repository root instead:
#
#   docker build -f Dockerfile.serving -t cloudproof-embedding:local .
#
# Kept as a signpost rather than deleted, because the path is referenced in
# older notes and a missing file is a worse error message than this one.
FROM alpine:3.20
RUN echo "Use Dockerfile.serving at the repository root instead." >&2 && exit 1
