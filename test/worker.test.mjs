import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const script = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script, compatibilityDate: '2026-09-01',
  bindings: { PRIMG_TOKEN: 'test-token' }, r2Buckets: ['IMAGES'],
}));
after(() => mf.dispose());
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const auth = { Authorization: 'Bearer test-token' };
const send = async (body, headers = auth) => {
  if (body instanceof FormData) {
    const encoded = new Response(body);
    headers = { ...headers, 'Content-Type': encoded.headers.get('Content-Type') };
    body = await encoded.arrayBuffer();
  }
  return mf.dispatchFetch('https://img.swifti.ng/upload', { method: 'POST', headers, body, duplex: 'half' });
};
function form(bytes = png, type = 'image/png', name = '../../private-name.png') {
  const body = new FormData();
  body.append('file', new Blob([bytes], { type }), name);
  return body;
}

test('authentication is required before body parsing', async () => {
  for (const Authorization of ['', 'Bearer wrong', 'Basic test-token']) {
    assert.equal((await send('bad body', { Authorization })).status, 401);
  }
});

test('upload and public read preserve bytes and metadata, with unique opaque URLs', async () => {
  const response = await send(form());
  assert.equal(response.status, 201);
  const { url } = await response.json();
  assert.match(url, /^https:\/\/img\.swifti\.ng\/f\/[a-f0-9]{32}\.png$/);
  const second = await (await send(form())).json();
  assert.notEqual(second.url, url);
  const image = await mf.dispatchFetch(url);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(image.headers.get('etag'));
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const head = await mf.dispatchFetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('JPEG and WebP signatures select canonical extensions', async () => {
  for (const [bytes, mime, extension] of [
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg', 'jpg'],
    [Buffer.from('RIFF0000WEBPVP8 '), 'image/webp', 'webp'],
  ]) {
    const response = await send(form(bytes, mime, 'untrusted.txt'));
    assert.equal(response.status, 201);
    const { url } = await response.json();
    assert.ok(url.endsWith(`.${extension}`));
    assert.equal((await mf.dispatchFetch(url)).headers.get('content-type'), mime);
  }
});

test('rejects unsupported, empty, and MIME-spoofed files', async () => {
  for (const [bytes, mime] of [[png, 'image/jpeg'], [png, 'text/plain'], ['<svg/>', 'image/png'], ['', 'image/png']]) {
    assert.equal((await send(form(bytes, mime))).status, 415);
  }
});

test('malformed multipart and invalid fields produce useful client errors', async () => {
  assert.equal((await send('not multipart')).status, 415);
  const malformed = await send('bad body', { ...auth, 'Content-Type': 'multipart/form-data; boundary=x' });
  assert.equal(malformed.status, 400);
  assert.ok((await malformed.json()).error);
  const missing = new FormData();
  missing.append('file', 'not a file');
  assert.equal((await send(missing)).status, 400);
  const duplicate = form();
  duplicate.append('file', new Blob([png], { type: 'image/png' }), 'second.png');
  assert.equal((await send(duplicate)).status, 400);
  const extra = form();
  extra.append('name', 'extra');
  assert.equal((await send(extra)).status, 400);
});

test('file and streamed body size limits are enforced', async () => {
  const big = new Uint8Array(20 * 1024 * 1024 + 1);
  big.set(png);
  assert.equal((await send(form(big))).status, 413);
  let remaining = 21;
  const stream = new ReadableStream({
    pull(controller) {
      if (remaining-- > 0) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    },
  });
  assert.equal((await send(stream, { ...auth, 'Content-Type': 'multipart/form-data; boundary=x' })).status, 413);
});

test('arbitrary R2 keys cannot be read and missing images return 404', async () => {
  const bucket = await mf.getR2Bucket('IMAGES');
  await bucket.put('secret.txt', 'private');
  for (const path of ['/f/secret.txt', '/f/%2e%2e/secret.txt', '/f/a/b.png', '/f/' + '0'.repeat(32) + '.png', '/']) {
    assert.equal((await mf.dispatchFetch('https://img.swifti.ng' + path)).status, 404);
  }
  assert.equal((await mf.dispatchFetch('https://img.swifti.ng/upload')).status, 405);
});

test('missing server secret fails closed', async () => {
  const unconfigured = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-09-01', r2Buckets: ['IMAGES'] }));
  try {
    const response = await unconfigured.dispatchFetch('https://example.com/upload', { method: 'POST', headers: auth });
    assert.equal(response.status, 503);
  } finally { await unconfigured.dispose(); }
});


test('CLI uploads awkward filenames, prints only a URL, and keeps errors on stderr', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'primg-test-'));
  const path = join(directory, 'screen ,;"\\ shot.png');
  const run = promisify(execFile);
  const env = { ...process.env, PRIMG_HOST: (await mf.ready).origin, PRIMG_TOKEN: 'test-token' };
  try {
    await writeFile(path, png);
    const { stdout, stderr } = await run('./primg', [path], { env });
    assert.equal(stderr, '');
    assert.match(stdout, /^http:\/\/[^\s]+\/f\/[a-f0-9]{32}\.png\n$/);
    const image = await fetch(stdout.trim());
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    for (const [file, token, message] of [
      [path, 'wrong', /HTTP 401/],
      [join(directory, 'missing.png'), 'test-token', /file not found/],
    ]) {
      await assert.rejects(run('./primg', [file], { env: { ...env, PRIMG_TOKEN: token } }), error => {
        assert.equal(error.stdout, '');
        assert.match(error.stderr, message);
        return true;
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
