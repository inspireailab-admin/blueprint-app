#!/usr/bin/env bash
# Provisions the Blueprint enrollment relay on AWS: a small EC2 instance with a
# stable Elastic IP, running the relay behind Caddy (auto Let's Encrypt TLS).
# Idempotent-ish; records every created resource id in resources.env so
# teardown.sh can remove them. Uses the `blueprint` CLI profile (no keys here).
set -euo pipefail

PROFILE=blueprint
REGION=us-east-1
NAME=blueprint-relay
MYIP="${MYIP:-$(curl -s https://checkip.amazonaws.com)}"  # SSH allow-list (this machine)
DIR="$(cd "$(dirname "$0")" && pwd)"
ENVF="$DIR/resources.env"

aws() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }

: > "$ENVF"
{ echo "PROFILE=$PROFILE"; echo "REGION=$REGION"; echo "KEY_NAME=$NAME"; } >> "$ENVF"

echo "== key pair =="
if ! aws ec2 describe-key-pairs --key-names "$NAME" >/dev/null 2>&1; then
  aws ec2 create-key-pair --key-name "$NAME" --query KeyMaterial --output text > "$DIR/$NAME.pem"
  chmod 600 "$DIR/$NAME.pem"
  echo "created key -> $DIR/$NAME.pem"
else
  echo "key pair already exists"
fi

echo "== security group =="
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=${NAME}-sg" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$SG" ] || [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name "${NAME}-sg" --description "Blueprint relay" --vpc-id "$VPC" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22  --cidr "${MYIP}/32" >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 80  --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  echo "created SG $SG"
else
  echo "SG already exists: $SG"
fi
echo "SG_ID=$SG" >> "$ENVF"

echo "== latest Amazon Linux 2023 AMI (via describe-images; no SSM needed) =="
AMI=$(aws ec2 describe-images --owners amazon \
  --filters "Name=name,Values=al2023-ami-2023.*-kernel-*-x86_64" \
            "Name=state,Values=available" "Name=architecture,Values=x86_64" \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
echo "AMI=$AMI"

echo "== launch t3.micro =="
IID=$(aws ec2 run-instances --image-id "$AMI" --instance-type t3.micro \
  --key-name "$NAME" --security-group-ids "$SG" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "INSTANCE_ID=$IID" >> "$ENVF"
echo "instance $IID"

echo "== elastic IP =="
ALLOC=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
echo "ALLOC_ID=$ALLOC" >> "$ENVF"
aws ec2 wait instance-running --instance-ids "$IID"
aws ec2 associate-address --instance-id "$IID" --allocation-id "$ALLOC" >/dev/null
EIP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
echo "EIP=$EIP" >> "$ENVF"

echo "=================================================="
echo " DONE."
echo "  Instance : $IID"
echo "  Elastic IP: $EIP"
echo "  Resources recorded in: $ENVF"
echo "=================================================="
