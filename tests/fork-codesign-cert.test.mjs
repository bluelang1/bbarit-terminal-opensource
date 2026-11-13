import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/fork-codesign-cert.sh', import.meta.url));
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

test('generates a self-signed code-signing p12 and prints the gh commands without the password', { skip: !hasOpenssl && 'openssl missing' }, () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'fork-codesign-')), 'cert');
  const stdout = execFileSync('bash', [script, out, '--repo', 'example/fork', '--name', 'Test Fork (self-signed)'], { encoding: 'utf8' });
  assert.deepEqual(readdirSync(out).sort(), [
    'fork-codesign.cert.pem', 'fork-codesign.key.pem', 'fork-codesign.p12', 'fork-codesign.p12.password',
  ]);
  if (process.platform !== 'win32') {
    for (const file of readdirSync(out)) assert.equal(statSync(path.join(out, file)).mode & 0o077, 0, `${file} is private`);
  }
  const password = readFileSync(path.join(out, 'fork-codesign.p12.password'), 'utf8');
  assert.match(password, /^[0-9a-f]{48}$/, 'password file has no trailing newline');
  assert.ok(!stdout.includes(password), 'the password is never printed');
  assert.match(stdout, /\| gh secret set FORK_CODESIGN_P12_BASE64 --repo example\/fork\n/);
  assert.match(stdout, /gh secret set FORK_CODESIGN_P12_PASSWORD --repo example\/fork < /);

  const certText = execFileSync('openssl', ['x509', '-in', path.join(out, 'fork-codesign.cert.pem'), '-noout', '-text'], { encoding: 'utf8' });
  assert.match(certText, /Subject:.*CN ?= ?Test Fork \(self-signed\)/);
  assert.match(certText, /Extended Key Usage: critical\s+Code Signing/);
  assert.match(certText, /CA:FALSE/);
  const fingerprint = execFileSync('openssl', ['x509', '-in', path.join(out, 'fork-codesign.cert.pem'), '-noout', '-fingerprint', '-sha1'], { encoding: 'utf8' })
    .replace(/^.*=/, '').replace(/:/g, '').trim().toLowerCase();
  // A one-certificate chain: codesign writes the self-signed cert as the root.
  assert.ok(stdout.includes(`identifier "com.bbarit.terminal.source" and certificate root = H"${fingerprint}"`));

  // macOS `security import` needs the PBE-SHA1-3DES / SHA-1 MAC layout.
  const info = spawnSync('openssl', ['pkcs12', '-in', path.join(out, 'fork-codesign.p12'), '-info', '-noout', '-passin', `pass:${password}`], { encoding: 'utf8' });
  assert.equal(info.status, 0, info.stderr);
  const details = info.stdout + info.stderr;
  // OpenSSL 3 names the MAC digest; LibreSSL only verifies it (its default is SHA-1).
  assert.match(details, /MAC: sha1\b|MAC verified OK/i);
  assert.match(details, /pbeWithSHA1And3-KeyTripleDES-CBC/);
  assert.doesNotMatch(details, /PBES2|RC2/);

  // Never overwrite an existing certificate.
  const again = spawnSync('bash', [script, out, '--repo', 'example/fork'], { encoding: 'utf8' });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /Refusing to overwrite/);
});

test('rejects names that would break the OpenSSL config', () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'fork-codesign-')), 'cert');
  const result = spawnSync('bash', [script, out, '--name', 'bad$name'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--name may only contain/);
});
