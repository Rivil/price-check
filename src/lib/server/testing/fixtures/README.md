# SMTP test certificates — TEST ONLY

These keys and certificates exist only for `../smtp-server.ts`, the in-process fake
SMTP server the tests run on 127.0.0.1. They are public, protect nothing and must
never be used by a real server or trusted outside the test suite.

- `smtp-test-ca.pem`: the test CA. Tests pass it to the client as its only trusted
  CA (`SMTP_TEST_CA`).
- `smtp-test-localhost.pem`, `smtp-test-localhost.key`: server cert for `localhost`
  and `127.0.0.1`, signed by the test CA: the `trusted` setting.
- `smtp-test-untrusted.pem`, `smtp-test-untrusted.key`: self-signed server cert for
  the same names, not chained to the test CA: the `untrusted` setting, which a
  verifying client must refuse.

All expire after 36500 days (2126). The CA's private key is not kept, so re-issuing
either server cert means re-issuing the CA with it: run all three commands, from this
directory, with OpenSSL 3.0 or later.

```sh
# 1. The test CA (its key is deleted at the end)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -noenc \
  -keyout smtp-test-ca.key -out smtp-test-ca.pem -days 36500 \
  -subj "/CN=amazon-price-check SMTP test CA - TEST ONLY" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

# 2. The trusted server cert, signed by that CA
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -noenc \
  -keyout smtp-test-localhost.key -out smtp-test-localhost.pem -days 36500 \
  -CA smtp-test-ca.pem -CAkey smtp-test-ca.key \
  -subj "/CN=localhost" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=serverAuth" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

# 3. The untrusted server cert: self-signed, same names
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -noenc \
  -keyout smtp-test-untrusted.key -out smtp-test-untrusted.pem -days 36500 \
  -subj "/CN=localhost" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=serverAuth" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

rm smtp-test-ca.key

# Check: the first must print OK, the second must fail
openssl verify -CAfile smtp-test-ca.pem smtp-test-localhost.pem
openssl verify -CAfile smtp-test-ca.pem smtp-test-untrusted.pem
```
