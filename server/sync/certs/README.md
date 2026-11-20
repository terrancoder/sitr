# Pinned certificates

`AppleRootCA-G3.cer` is Apple Root CA - G3 (DER, 583 bytes; subject and
issuer "CN=Apple Root CA - G3, OU=Apple Certification Authority, O=Apple
Inc., C=US"; valid 30 April 2014 to 30 April 2039), downloaded from
Apple's certificate authority page (https://www.apple.com/certificateauthority/)
on 20 November 2026. Its SHA-256 fingerprint is
`63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79`,
pinned as `APPLE_ROOT_CA_G3_FINGERPRINT256` in `src/apple.ts`. The server
does not load this file: it compares the fingerprint of the root inside
each receipt's own chain, and `tests/src/appleVerify.test.ts` checks the
file against the constant. Before the first deployment, a person must
compare this fingerprint with the one on Apple's page
(`openssl x509 -inform DER -in AppleRootCA-G3.cer -noout -fingerprint -sha256`).
