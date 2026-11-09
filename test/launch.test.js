import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanFields, cleanUrl, cleanNetwork, sniffImage, decodeImage, checkRpcBody, devBuyOk, LaunchError } from '../server/launch.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

test('fields: trims, upper-cases the ticker, drops a leading $', () => {
  const f = cleanFields({ name: '  Frog  ', symbol: '$frog', description: 'hi', twitter: 'https://x.com/frog' });
  assert.equal(f.name, 'Frog');
  assert.equal(f.symbol, 'FROG');
  assert.equal(f.twitter, 'https://x.com/frog');
  assert.equal(f.website, '');
});

test('fields: rejects blanks, long values and odd tickers', () => {
  assert.throws(() => cleanFields({ name: '', symbol: 'A' }), LaunchError);
  assert.throws(() => cleanFields({ name: 'x', symbol: '' }), LaunchError);
  assert.throws(() => cleanFields({ name: 'x'.repeat(33), symbol: 'A' }), /32/);
  assert.throws(() => cleanFields({ name: 'x', symbol: 'ABCDEFGHIJK' }), /10/);
  assert.throws(() => cleanFields({ name: 'x', symbol: 'A B' }), /letters/);
  assert.throws(() => cleanFields({ name: 'x', symbol: 'A', description: 'y'.repeat(601) }), /600/);
});

test('fields: rejects hidden direction and control characters', () => {
  assert.throws(() => cleanFields({ name: 'a‮b', symbol: 'A' }), /hidden/);
  assert.throws(() => cleanFields({ name: 'a\u0000b', symbol: 'A' }), /hidden/);
  assert.doesNotThrow(() => cleanFields({ name: 'x', symbol: 'A', description: 'line one\nline two' }));
});

test('links: https only, and X / Telegram must be on their own hosts', () => {
  assert.equal(cleanUrl('website', ''), '');
  assert.equal(cleanUrl('website', 'https://example.com/'), 'https://example.com');
  assert.throws(() => cleanUrl('website', 'http://example.com'), LaunchError);
  assert.throws(() => cleanUrl('website', 'javascript:alert(1)'), LaunchError);
  assert.throws(() => cleanUrl('twitter', 'https://evil.com/x'), /x\.com/);
  assert.throws(() => cleanUrl('telegram', 'https://x.com/a'), /t\.me/);
  assert.equal(cleanUrl('telegram', 'https://t.me/frog'), 'https://t.me/frog');
});

test('network and dev buy', () => {
  assert.equal(cleanNetwork('mainnet'), 'mainnet');
  assert.throws(() => cleanNetwork('testnet'), LaunchError);
  assert.equal(devBuyOk('0.5'), 0.5);
  assert.throws(() => devBuyOk(0), LaunchError);
  assert.throws(() => devBuyOk('abc'), LaunchError);
  assert.throws(() => devBuyOk(999), /capped/);
});

test('image: type comes from the bytes, not the claim', () => {
  assert.equal(sniffImage(png).ext, 'png');
  assert.equal(decodeImage(dataUrl(png)).type, 'image/png');
  assert.equal(decodeImage(dataUrl(png, 'image/jpeg')).type, 'image/png'); // lying mime
  assert.throws(() => decodeImage(dataUrl(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml')), /not a PNG/);
  assert.throws(() => decodeImage(''), /picture/);
  assert.throws(() => decodeImage(dataUrl(Buffer.concat([png, Buffer.alloc(1_600_000)]))), /1\.5 MB/);
});

test('rpc proxy: only launch methods pass, airdrop only on devnet, batch capped', () => {
  assert.doesNotThrow(() => checkRpcBody({ method: 'getBalance' }, 'mainnet'));
  assert.doesNotThrow(() => checkRpcBody([{ method: 'getSlot' }, { method: 'sendTransaction' }], 'mainnet'));
  assert.throws(() => checkRpcBody({ method: 'getProgramAccounts' }, 'mainnet'), /not allowed/);
  assert.throws(() => checkRpcBody([{ method: 'getSlot' }, { method: 'getTokenLargestAccounts' }], 'devnet'), /not allowed/);
  assert.throws(() => checkRpcBody({ method: 'requestAirdrop' }, 'mainnet'), /devnet/);
  assert.doesNotThrow(() => checkRpcBody({ method: 'requestAirdrop' }, 'devnet'));
  assert.throws(() => checkRpcBody(Array.from({ length: 21 }, () => ({ method: 'getSlot' })), 'devnet'), /Too many/);
  assert.throws(() => checkRpcBody(null, 'devnet'), LaunchError);
});
