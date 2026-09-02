#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ ${WAYNODE_CI_DEPLOY:-} == 1 ]] || {
  printf 'FATAL: Waynode TLS reconciliation is CI-only.\n' >&2
  exit 64
}

source_dir=${STAGED_SOURCE_DIR:?Set STAGED_SOURCE_DIR to the verified source}
deploy_sha=${DEPLOY_SHA:?Set DEPLOY_SHA to the exact Git commit}
deploy_id=${DEPLOY_ID:?Set DEPLOY_ID to the workflow run id}
domain=waynode.fornace.net
cert_name=waynode.fornace.net-managed
contact=info@fornacestudio.com
webroot=/var/www/certbot
nginx_source=$source_dir/.github/deploy/waynode.nginx.conf
nginx_target=/etc/nginx/sites-available/waynode
nginx_enabled=/etc/nginx/sites-enabled/waynode
renewal_config=/etc/letsencrypt/renewal/$cert_name.conf
cert_root=/etc/letsencrypt/live/$cert_name
verification_marker=/var/lib/waynode/tls-renewal-verified
backup_root=/var/backups/waynode/tls/$deploy_sha-$deploy_id
expected_nginx_sha=5f3711154325661c267569e49e478e88d3255985301f560aaf573c3ebb3c8e43
legacy_nginx_sha=f87ad57084c7a570b00f06a13eb3fd179d52b6221acca7cbc218a56fba628919

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; false; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required."; }
for command in certbot curl install nginx openssl sha256sum systemctl timeout; do need "$command"; done

[[ -f $nginx_source ]] || die "Pinned Nginx artifact is missing."
[[ $(sha256sum "$nginx_source" | awk '{print $1}') == "$expected_nginx_sha" ]] \
  || die "Pinned Nginx artifact hash mismatch."
[[ -f $nginx_target && -L $nginx_enabled ]] || die "Expected Waynode Nginx site is not installed."
[[ $(readlink -f "$nginx_enabled") == "$nginx_target" ]] \
  || die "Enabled Waynode site does not resolve to the managed target."
current_nginx_sha=$(sha256sum "$nginx_target" | awk '{print $1}')
case $current_nginx_sha in
  "$legacy_nginx_sha"|"$expected_nginx_sha") ;;
  *) die "Production Waynode Nginx configuration drifted from both accepted versions." ;;
esac

install -d -m 755 "$webroot/.well-known/acme-challenge" /var/lib/waynode
install -d -m 700 "$backup_root"
cp -a "$nginx_target" "$backup_root/nginx.before"

challenge_name=waynode-ci-$deploy_sha
challenge_path=$webroot/.well-known/acme-challenge/$challenge_name
challenge_body=$deploy_sha-$deploy_id
printf '%s' "$challenge_body" >"$challenge_path"
chmod 0644 "$challenge_path"
cleanup_challenge() { rm -f "$challenge_path"; }
trap cleanup_challenge EXIT
served_body=$(curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  "http://$domain/.well-known/acme-challenge/$challenge_name")
[[ $served_body == "$challenge_body" ]] || die "Public ACME webroot preflight returned the wrong body."
cleanup_challenge

new_lineage=0
if [[ ! -f $renewal_config || ! -f $cert_root/fullchain.pem || ! -f $cert_root/privkey.pem ]]; then
  new_lineage=1
  certbot certonly --non-interactive --agree-tos --no-eff-email --email "$contact" \
    --webroot --webroot-path "$webroot" --preferred-challenges http \
    --cert-name "$cert_name" -d "$domain" \
    --deploy-hook '/usr/bin/systemctl reload nginx.service'
fi

[[ -f $renewal_config && -f $cert_root/fullchain.pem && -f $cert_root/privkey.pem ]] \
  || die "Managed Certbot lineage is incomplete."
grep -Fq 'authenticator = webroot' "$renewal_config" \
  || die "Managed lineage does not persist the webroot authenticator."
grep -Fq "$webroot" "$renewal_config" \
  || die "Managed lineage does not persist the production webroot."
openssl x509 -in "$cert_root/fullchain.pem" -noout -checkhost "$domain" \
  || die "Managed certificate does not cover $domain."
openssl x509 -in "$cert_root/fullchain.pem" -noout -checkend 1209600 \
  || die "Managed certificate has less than 14 days remaining."

if [[ $new_lineage == 1 || ! -f $verification_marker ]]; then
  certbot renew --cert-name "$cert_name" --dry-run --no-random-sleep-on-renew \
    --run-deploy-hooks
  printf 'lineage=%s\nverified_at=%s\n' "$cert_name" "$(date -u +%FT%TZ)" \
    >"$verification_marker"
  chmod 0600 "$verification_marker"
fi

nginx_changed=0
old_live_retired=0
old_archive_retired=0
rollback() {
  local status=${1:-$?}
  trap - ERR HUP INT TERM
  set +e
  if [[ $old_live_retired == 1 ]]; then
    mv "$backup_root/retired-original-live" /etc/letsencrypt/live/waynode.fornace.net
  fi
  if [[ $old_archive_retired == 1 ]]; then
    mv "$backup_root/retired-original-archive" /etc/letsencrypt/archive/waynode.fornace.net
  fi
  if [[ $nginx_changed == 1 ]]; then
    cp -a "$backup_root/nginx.before" "$nginx_target"
    nginx -t && systemctl reload nginx.service
  fi
  exit "$status"
}
trap 'rollback $?' ERR
trap 'rollback 130' HUP INT TERM

if [[ $current_nginx_sha != "$expected_nginx_sha" ]]; then
  install -m 0644 "$nginx_source" "$nginx_target.candidate"
  mv "$nginx_target.candidate" "$nginx_target"
  nginx_changed=1
fi
nginx -t
systemctl reload nginx.service

local_fingerprint=$(openssl x509 -in "$cert_root/fullchain.pem" -noout -fingerprint -sha256)
public_fingerprint=$(timeout 15 openssl s_client -connect "$domain:443" \
  -servername "$domain" </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256)
[[ $public_fingerprint == "$local_fingerprint" ]] \
  || die "Public endpoint is not serving the managed certificate."
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  "https://$domain/api/health/ready" >/dev/null

if [[ -d /etc/letsencrypt/live/waynode.fornace.net ]]; then
  mv /etc/letsencrypt/live/waynode.fornace.net "$backup_root/retired-original-live"
  old_live_retired=1
fi
if [[ -d /etc/letsencrypt/archive/waynode.fornace.net ]]; then
  mv /etc/letsencrypt/archive/waynode.fornace.net "$backup_root/retired-original-archive"
  old_archive_retired=1
fi

trap - ERR HUP INT TERM
say "Waynode TLS lineage, renewal dry-run, Nginx certificate, and public endpoint verified."
