#!/usr/bin/env bash
# Removes everything provision.sh created (reverses all billable resources).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/resources.env" ] || { echo "no resources.env — nothing to tear down"; exit 0; }
# shellcheck disable=SC1090
source "$DIR/resources.env"
aws() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }

if [ -n "${INSTANCE_ID:-}" ]; then
  echo "terminating instance $INSTANCE_ID"
  aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" >/dev/null || true
  aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID" || true
fi
if [ -n "${ALLOC_ID:-}" ]; then
  echo "releasing Elastic IP $ALLOC_ID"
  aws ec2 release-address --allocation-id "$ALLOC_ID" || true
fi
if [ -n "${SG_ID:-}" ]; then
  echo "deleting security group $SG_ID"
  aws ec2 delete-security-group --group-id "$SG_ID" || true
fi
if [ -n "${KEY_NAME:-}" ]; then
  echo "deleting key pair $KEY_NAME"
  aws ec2 delete-key-pair --key-name "$KEY_NAME" || true
fi
echo "torn down."
