#!/usr/bin/env bash
# Generates the fork's self-signed macOS code-signing certificate (one time).
#
# A release signed with one fixed certificate has the designated requirement
#   identifier "com.bbarit.terminal.source" and certificate root = H"<sha1>"
# instead of an ad-hoc cdhash, so macOS privacy grants (Documents, Desktop,
# Downloads, ...) survive app updates. This is not an Apple Developer ID and
# does not notarize anything; Gatekeeper treats the app as before.
#
# Usage: scripts/fork-codesign-cert.sh <out-dir> [--repo owner/name] [--name "Common Name"]
#
# Writes into <out-dir> (which must not already hold these files):
#   fork-codesign.key.pem      private key (keep offline, never commit)
#   fork-codesign.cert.pem     certificate
#   fork-codesign.p12          key + certificate for the release workflow
#   fork-codesign.p12.password random password of the .p12
# and prints the `gh secret set` commands to run. It never runs them, never
# imports anything into a keychain and never prints the password.
#
# The .p12 uses PBE-SHA1-3DES + a SHA-1 MAC: OpenSSL 3's default PKCS#12
# (PBES2/AES-256 + SHA-256 MAC) is rejected by `security import` on many
# macOS versions, and RC2 (`-legacy`) needs OpenSSL's legacy provider. Set
# OPENSSL=/path/to/openssl to choose the binary (LibreSSL and OpenSSL 3 work).
set -euo pipefail

usage() {
  grep '^# Usage:' "$0" | sed 's/^# //' >&2
  exit 2
}

out_dir=""
repo=""
common_name="BBARIT Terminal Source (self-signed)"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || usage; repo="$2"; shift 2 ;;
    --name) [ $# -ge 2 ] || usage; common_name="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) [ -z "$out_dir" ] || usage; out_dir="$1"; shift ;;
  esac
done
[ -n "$out_dir" ] || usage
# The name goes into an OpenSSL config file; keep it to plain characters.
if ! printf '%s' "$common_name" | grep -Eq '^[A-Za-z0-9 ().,_-]+$'; then
  echo "--name may only contain letters, digits, spaces and ().,_-" >&2
  exit 2
fi

openssl_bin="${OPENSSL:-openssl}"
command -v "$openssl_bin" >/dev/null || { echo "openssl not found ($openssl_bin)" >&2; exit 1; }

if [ -z "$repo" ]; then
  # Default to the origin remote of this checkout (gh would otherwise ask when
  # the clone also has an `upstream` remote).
  origin="$(git -C "$(dirname "$0")/.." remote get-url origin 2>/dev/null || true)"
  repo="$(printf '%s\n' "$origin" | sed -nE 's#^(https://github\.com/|git@github\.com:)([^/]+/[^/]+)$#\2#p' | sed 's/\.git$//')"
fi

umask 077
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
key="$out_dir/fork-codesign.key.pem"
cert="$out_dir/fork-codesign.cert.pem"
p12="$out_dir/fork-codesign.p12"
password_file="$out_dir/fork-codesign.p12.password"
for file in "$key" "$cert" "$p12" "$password_file"; do
  if [ -e "$file" ]; then
    echo "Refusing to overwrite $file. Losing the old certificate resets macOS folder permissions once more; pick a new directory on purpose." >&2
    exit 1
  fi
done

# From here on a failed step removes the partial output (the existence check
# above guarantees these files are ours).
config="$(mktemp "${TMPDIR:-/tmp}/fork-codesign.XXXXXX")"
completed=0
cleanup() {
  rm -f "$config"
  if [ "$completed" != 1 ]; then rm -f "$key" "$cert" "$p12" "$password_file"; fi
}
trap cleanup EXIT

# The subject lives in the config: LibreSSL (macOS /usr/bin/openssl) ignores
# -subj when prompt = no.
cat > "$config" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${common_name}
O = BBARIT Terminal Source fork
[codesign]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

# 10 years: codesign refuses an expired certificate, and a new certificate
# changes the designated requirement (one more permission reset).
log="$("$openssl_bin" req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
  -config "$config" -extensions codesign \
  -keyout "$key" -out "$cert" 2>&1)" || { printf '%s\n' "$log" >&2; exit 1; }

# No trailing newline: `gh secret set < file` would keep it in the secret.
printf '%s' "$("$openssl_bin" rand -hex 24)" > "$password_file"
"$openssl_bin" pkcs12 -export -inkey "$key" -in "$cert" -name "$common_name" \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 \
  -passout "file:$password_file" -out "$p12"

subject="$("$openssl_bin" x509 -in "$cert" -noout -subject)"
case "$subject" in
  *"CN=$common_name"*|*"CN = $common_name"*) ;;
  *) echo "Unexpected certificate subject: $subject" >&2; exit 1 ;;
esac
fingerprint="$("$openssl_bin" x509 -in "$cert" -noout -fingerprint -sha1 | sed 's/^.*=//; s/://g')"
not_after="$("$openssl_bin" x509 -in "$cert" -noout -enddate | sed 's/^notAfter=//')"
repo_arg=""
[ -z "$repo" ] || repo_arg=" --repo $repo"
completed=1

cat <<EOF
Created a self-signed code-signing certificate in $out_dir
  subject:  CN=$common_name
  SHA-1:    $fingerprint
  expires:  $not_after
Release builds signed with it get the designated requirement
  identifier "com.bbarit.terminal.source" and certificate root = H"$(printf '%s' "$fingerprint" | tr 'A-F' 'a-f')"

Set the repository secrets (this script does not run them):
  base64 < "$p12" | gh secret set FORK_CODESIGN_P12_BASE64$repo_arg
  gh secret set FORK_CODESIGN_P12_PASSWORD$repo_arg < "$password_file"

Keep $out_dir offline and backed up (password manager or encrypted disk).
Never commit it. Losing it means the next release has a new certificate and
macOS asks for folder permissions one more time.
EOF
