# --- Self-healing adoption ---
#
# If Cloudflare already has the bucket but the platform state does not track it
# (a first apply that created it and then lost its state write, or a recovered
# workspace), a create would fail with "bucket already exists". Look it up at
# plan time with the job's brokered credentials and import it instead. A fresh
# environment resolves to name = "" and creates normally; a bucket already in
# state short-circuits the lookup.

data "external" "adopt_exports_bucket" {
  program = ["bash", "-c", <<-EOT
    set -euo pipefail
    name="$(jq -r .name)"
    state_file="$(mktemp)"
    trap 'rm -f "$state_file"' EXIT
    code="$(curl -s -o "$state_file" -w '%%{http_code}' \
      -u "$TF_HTTP_USERNAME:$TF_HTTP_PASSWORD" "$TF_HTTP_ADDRESS" || echo 000)"
    if [ "$code" = "200" ] && jq -e \
        '[.resources[]? | select(.type == "cloudflare_r2_bucket" and .name == "exports")] | length > 0' \
        "$state_file" >/dev/null 2>&1; then
      jq -n '{name: ""}'
      exit 0
    fi
    code="$(curl -s -o /dev/null -w '%%{http_code}' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$name" || echo 000)"
    if [ "$code" = "200" ]; then
      jq -n --arg n "$name" '{name: $n}'
    else
      jq -n '{name: ""}'
    fi
  EOT
  ]
  query = {
    name = local.exports_bucket_name
  }
}

import {
  for_each = toset(compact([data.external.adopt_exports_bucket.result.name]))
  to       = cloudflare_r2_bucket.exports
  id       = "${var.cloudflare_account_id}/${each.value}"
}
