# Thin overlay on the upstream cocoon PDS image that bakes in this experiment's
# rotation key + JWK so the Cloud Run app container has them without a volume
# mount or Secret Manager. These are THROWAWAY keys for the scale-to-zero demo
# PDS only (the account's identity is a did:plc registered on plc.directory; the
# rotation key only controls that did's PLC updates). Do NOT reuse for anything
# real.
#
# Base image is built from github.com/haileyok/cocoon by Cloud Build:
#   europe-west1-docker.pkg.dev/blob-pglite/zeropg/cocoon-pds:latest
ARG BASE=europe-west1-docker.pkg.dev/blob-pglite/zeropg/cocoon-pds:latest
FROM ${BASE}

COPY keys/rotation.key /keys/rotation.key
COPY keys/jwk.key /keys/jwk.key

# cocoon's default CMD is ["/cocoon", "run"]; inherit it.
