#!/bin/bash
# Generates TEST-ONLY certificate chains shaped like Apple's App Store
# signing chain (root -> intermediate -> leaf, EC P-256, Apple's two
# extension OIDs), for the claim service's Apple verifier tests
# (docs/sync-protocol.md §How this is tested before Apple's setup exists).
# Every key here is a throwaway test key, never trusted by production.
# Usage: bash tests/fixtures/apple/gen.sh   (needs OpenSSL >= 3.4 for -not_before)
set -euo pipefail
cd "$(dirname "$0")"
rm -f ./*.pem ./*.cnf
GOOD="-not_before 20200101000000Z -not_after 20991231000000Z"
cat > ext.cnf <<'CNF'
[root]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
[inter]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
1.2.840.113635.100.6.2.1 = ASN1:NULL
[inter_nooid]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
1.2.840.113635.100.6.11.1 = ASN1:NULL
[leaf_nooid]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
[leaf_ca]
basicConstraints = critical, CA:TRUE
1.2.840.113635.100.6.11.1 = ASN1:NULL
CNF
key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:"${2:-P-256}" -out "$1-key.pem" 2>/dev/null; }
selfsigned() { # name cn
  key "$1"
  openssl req -new -x509 -key "$1-key.pem" -subj "/CN=$2" $GOOD -sha256 \
    -config <(printf '[req]\ndistinguished_name=dn\n[dn]\n'; cat ext.cnf) -extensions root -out "$1.pem"
}
issue() { # name cn issuer section [curve] [validity]
  key "$1" "${5:-P-256}"
  openssl req -new -key "$1-key.pem" -subj "/CN=$2" -out "$1.csr" 2>/dev/null
  openssl x509 -req -in "$1.csr" -CA "$3.pem" -CAkey "$3-key.pem" -sha256 \
    ${6:-$GOOD} -extfile ext.cnf -extensions "$4" -out "$1.pem" 2>/dev/null
  rm "$1.csr"
}
selfsigned root "Sitr Test Root"
issue inter "Sitr Test Intermediate" root inter
issue leaf "Sitr Test Leaf" inter leaf
selfsigned root2 "Sitr Other Root"
issue inter2 "Sitr Other Intermediate" root2 inter
issue leaf_other "Sitr Other Leaf" inter2 leaf
issue leaf_nooid "Sitr Leaf Without OID" inter leaf_nooid
issue inter_nooid "Sitr Intermediate Without OID" root inter_nooid
issue leaf_under_nooid "Sitr Leaf Under No-OID Intermediate" inter_nooid leaf
issue leaf_ca "Sitr Leaf Marked CA" inter leaf_ca
issue leaf_p384 "Sitr Leaf P-384" inter leaf P-384
issue leaf_expired "Sitr Expired Leaf" inter leaf P-256 "-not_before 20200101000000Z -not_after 20210101000000Z"
rm ext.cnf
# Keys only the tests' signer needs are kept; CA keys are not.
rm -f root-key.pem root2-key.pem inter-key.pem inter2-key.pem inter_nooid-key.pem
echo "generated: $(ls *.pem | tr '\n' ' ')"
