#!/usr/bin/env node
// Download incompetech.com tracks matching any of the selected Feels into audio/ (one at a time),
// and write all their metadata to audio-metadata.txt.
//
// Usage: node download-audio.mjs [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(ROOT, 'audio');
const META_PATH = path.join(ROOT, 'audio-metadata.txt');
const BASE = 'https://incompetech.com/music/royalty-free/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

const FEELS = ['Relaxed', 'Grooving', 'Calming', 'Driving', 'Suspenseful', 'Mysterious', 'Somber'];
const MAX_SECONDS = 10 * 60;
// Stay under GitHub's large-file limit.
const MAX_BYTES = 50 * 1024 * 1024;
const DRY_RUN = process.argv.includes('--dry-run');

class TooLargeError extends Error {}
const tooLarge = (bytes) => new TooLargeError(`${(bytes / 1048576).toFixed(1)} MB exceeds 50 MB limit`);

// Copied from the `genres` array in music.html (there is no genres.json).
const GENRES = {
  2: 'African', 3: 'Blues', 4: 'Classical', 5: 'Contemporary', 6: 'Disco', 7: 'Electronica', 8: 'Funk',
  9: 'Holiday', 10: 'Horror', 11: 'Jazz', 12: 'Latin', 13: 'Modern', 14: 'Musical', 15: 'Polka', 16: 'Pop',
  18: 'Reggae', 19: 'Rock', 20: 'Silent Film Score', 21: 'Ska', 22: 'Soundtrack', 23: 'Stings',
  24: 'Unclassifiable', 25: 'World', 26: 'Urban',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, opts = {}, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(2000 * attempt);
    }
  }
}

async function getJson(url) {
  const res = await request(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function download(url, dest) {
  const tmp = `${dest}.part`;
  const res = await request(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const expected = Number(res.headers.get('content-length'));
  if (expected > MAX_BYTES) {
    await res.body?.cancel();
    throw tooLarge(expected);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  const actual = fs.statSync(tmp).size;
  if (expected && expected !== actual) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Incomplete download (${actual}/${expected} bytes)`);
  }
  if (actual > MAX_BYTES) {
    fs.rmSync(tmp, { force: true });
    throw tooLarge(actual);
  }
  fs.renameSync(tmp, dest);
  return actual;
}

const splitFeels = (feel) => (feel || '').split(',').map((f) => f.trim()).filter(Boolean);

const toSeconds = (length) =>
  (length || '').split(':').reduce((sum, part) => sum * 60 + Number(part || 0), 0);

const formatLength = (length) => (length || '').replace(/^00:/, '').replace(/^0(\d:)/, '$1');

function localName(filename) {
  let name = filename;
  try {
    name = decodeURIComponent(name);
  } catch {}
  return name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+(\.mp3)$/i, '$1').trim();
}

function metadataBlock(p, collections) {
  const col = collections.get(String(p.collection));
  const fields = [
    ['File', p.localName],
    ['Title', p.title],
    ['Feel', p.feel],
    ['Genre', GENRES[p.genre] || p.genre],
    ['Album', col && `${col.collection_name} (${col.collection_category})`],
    ['Length', formatLength(p.length)],
    ['BPM', p.bpm],
    ['Instruments', p.instruments],
    ['Description', p.description && p.description.replace(/\s+/g, ' ').trim()],
    ['ISRC', p.isrc],
    ['Uploaded', p.uploaded],
    ['Track page', `${BASE}index.html?isrc=${p.isrc}`],
    ['MP3 URL', p.url],
    ['iTunes', p.itunes],
    ['filmmusic.io', p.filmmusicURL],
    ['Video', p.video],
    ['Sheet music', p.sheetmusic],
    [
      'Attribution',
      `"${p.title}" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/`,
    ],
  ];
  return fields
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

function writeMetadata(tracks, collections) {
  const blocks = tracks
    .filter((p) => fs.existsSync(path.join(AUDIO_DIR, p.localName)))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((p) => metadataBlock(p, collections));
  fs.writeFileSync(META_PATH, blocks.join('\n\n') + '\n');
  return blocks.length;
}

async function main() {
  const [pieces, collectionList] = await Promise.all([
    getJson(`${BASE}pieces.json`),
    getJson(`${BASE}collections.json`),
  ]);
  const collections = new Map(collectionList.map((c) => [String(c.code), c]));

  const seen = new Set();
  const tracks = [];
  let tooLong = 0;
  for (const p of pieces) {
    if (!p.filename || !splitFeels(p.feel).some((f) => FEELS.includes(f))) continue;
    if (toSeconds(p.length) > MAX_SECONDS) {
      tooLong++;
      continue;
    }
    const name = localName(p.filename);
    if (seen.has(name)) continue;
    seen.add(name);
    tracks.push({ ...p, localName: name, url: `${BASE}mp3-royaltyfree/${encodeURIComponent(p.filename)}` });
  }
  console.log(`${tracks.length} matching tracks (${tooLong} skipped for being longer than 10 min)`);

  if (DRY_RUN) {
    for (const p of tracks) console.log(`${p.localName}  [${p.length}]  [${p.feel}]`);
    return;
  }

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const failed = [];
  for (const [i, p] of tracks.entries()) {
    const label = `[${i + 1}/${tracks.length}]`;
    const dest = path.join(AUDIO_DIR, p.localName);
    if (fs.existsSync(dest)) {
      console.log(`${label} skip (already downloaded) ${p.localName}`);
      continue;
    }
    try {
      const bytes = await download(p.url, dest);
      writeMetadata(tracks, collections);
      console.log(`${label} ${p.localName} (${(bytes / 1048576).toFixed(1)} MB) [${p.feel}]`);
    } catch (err) {
      if (err instanceof TooLargeError) {
        console.log(`${label} skip (${err.message}) ${p.localName}`);
        continue;
      }
      failed.push(p.localName);
      console.error(`${label} FAILED ${p.localName}: ${err.message}`);
    }
  }

  const count = writeMetadata(tracks, collections);
  console.log(`Done. ${count} tracks in audio-metadata.txt.`);
  if (failed.length) console.log(`${failed.length} failed (re-run to retry):\n  ${failed.join('\n  ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
