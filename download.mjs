#!/usr/bin/env node
// Crawl https://dareful.com/ page by page and download each video (one at a time) into videos/,
// recording file name, tags and page URL in video-tags-map.csv.
//
// Usage: node download.mjs [--from N] [--to N]

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VIDEOS_DIR = path.join(ROOT, 'videos');
const CSV_PATH = path.join(ROOT, 'video-tags-map.csv');
const BASE = 'https://dareful.com/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const FROM = argVal('--from', 1);
const TO = argVal('--to', Infinity);
// Stay under GitHub's large-file limit.
const MAX_BYTES = 50 * 1024 * 1024;

class TooLargeError extends Error {}
const tooLarge = (bytes) => new TooLargeError(`${(bytes / 1048576).toFixed(1)} MB exceeds 50 MB limit`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&#8217;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();

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

async function getHtml(url) {
  const res = await request(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const pageUrl = (n) => (n === 1 ? BASE : `${BASE}page/${n}/`);

function parseListing(html) {
  const cards = [];
  for (const chunk of html.split(/<article\b/).slice(1)) {
    const body = chunk.split('</article>')[0];
    const play = body.match(/<a href="([^"]+)" class="play"/);
    const btn = parseMuxButton(body);
    if (play) cards.push({ url: play[1], ...btn });
  }
  return cards;
}

function parseMuxButton(html, mainOnly = false) {
  const re = mainOnly ? /<a\b[^>]*class="[^"]*main-button[^"]*mux-button[^"]*"[^>]*>/ : /<a\b[^>]*mux-button[^>]*>/;
  const tag = html.match(re)?.[0];
  if (!tag) return {};
  return {
    playbackId: tag.match(/href="https:\/\/stream\.mux\.com\/([^".\/]+)\.m3u8"/)?.[1],
    fileName: tag.match(/data-file-name="([^"]+)"/)?.[1],
    muxId: tag.match(/data-mux-id="([^"]+)"/)?.[1],
  };
}

function parseTags(html) {
  const tags = [];
  for (const m of html.matchAll(/<a\b[^>]*href="https:\/\/dareful\.com\/videos\/[^"]+"[^>]*rel="tag"[^>]*>([^<]+)<\/a>/g)) {
    const t = decode(m[1]);
    if (t && !tags.includes(t)) tags.push(t);
  }
  return tags;
}

const csvField = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function parseCsvLine(line) {
  const fields = [];
  for (const m of line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)) {
    fields.push(m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1]);
  }
  return fields;
}

// Returns { byUrl: Map<pageUrl, fileName>, names: Set<fileName> } from the existing CSV.
function loadDone() {
  const done = { byUrl: new Map(), names: new Set() };
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, 'file name,tags,url\n');
    return done;
  }
  for (const line of fs.readFileSync(CSV_PATH, 'utf8').split('\n').slice(1)) {
    if (!line.trim()) continue;
    const [name, , url] = parseCsvLine(line);
    done.byUrl.set(url, name);
    done.names.add(name);
  }
  return done;
}

// Different posts sometimes share the same data-file-name; fall back to the post slug, then a counter.
function uniqueFileName(baseName, postUrl, names) {
  const slug = new URL(postUrl).pathname.split('/').filter(Boolean).pop();
  for (const candidate of new Set([baseName, slug])) {
    if (!names.has(`${candidate}.mp4`)) return `${candidate}.mp4`;
  }
  for (let i = 2; ; i++) {
    if (!names.has(`${baseName}-${i}.mp4`)) return `${baseName}-${i}.mp4`;
  }
}

// Mirrors the site's scripts.js: ask the page to enable/prepare the MP4 rendition, then poll.
async function prepareMp4(postUrl, muxId) {
  const post = (body) =>
    request(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams(body),
    }).then((r) => r.json());
  await post({ muxIdMp4Status: muxId });
  for (let i = 0; i < 60; i++) {
    const data = JSON.parse((await post({ getMaster: muxId })).mux_response).data;
    if (data.static_renditions?.status === 'ready') return data.playback_ids[0].id;
    await sleep(5000);
  }
  throw new Error('MP4 rendition not ready after waiting');
}

async function download(url, dest) {
  const tmp = `${dest}.part`;
  const res = await request(url);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
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

async function processVideo(card, done, label) {
  const html = await getHtml(card.url);
  if (!html) throw new Error(`Post page not found: ${card.url}`);
  const main = parseMuxButton(html, true);
  const playbackId = main.playbackId || card.playbackId;
  const baseName = main.fileName || card.fileName;
  const muxId = main.muxId || card.muxId;
  if (!playbackId || !baseName) throw new Error('No download button found');

  const recorded = done.byUrl.get(card.url);
  if (recorded && fs.existsSync(path.join(VIDEOS_DIR, recorded))) {
    console.log(`${label} skip (already downloaded) ${recorded}`);
    return;
  }
  const fileName = recorded || uniqueFileName(baseName, card.url, done.names);
  const dest = path.join(VIDEOS_DIR, fileName);
  const tags = parseTags(html);

  const mp4Url = (id) => `https://stream.mux.com/${id}/high.mp4?download=${encodeURIComponent(baseName)}`;
  let bytes;
  try {
    try {
      bytes = await download(mp4Url(playbackId), dest);
    } catch (err) {
      if (!err.status || !muxId) throw err;
      console.log(`${label} MP4 not available (HTTP ${err.status}), requesting rendition...`);
      bytes = await download(mp4Url(await prepareMp4(card.url, muxId)), dest);
    }
  } catch (err) {
    if (!(err instanceof TooLargeError)) throw err;
    console.log(`${label} skip (${err.message}) ${fileName}`);
    return;
  }

  if (!recorded) {
    fs.appendFileSync(CSV_PATH, [fileName, tags.join(', '), card.url].map(csvField).join(',') + '\n');
    done.byUrl.set(card.url, fileName);
    done.names.add(fileName);
  }
  console.log(`${label} ${fileName} (${(bytes / 1048576).toFixed(1)} MB) [${tags.join(', ')}]`);
}

async function main() {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const done = loadDone();
  const failures = [];
  const seen = new Set();
  let count = 0;

  for (let page = FROM; page <= TO; page++) {
    const html = await getHtml(pageUrl(page));
    if (!html) {
      console.log(`Page ${page} not found — reached the last page.`);
      break;
    }
    const cards = parseListing(html).filter((c) => !seen.has(c.url) && seen.add(c.url));
    if (!cards.length) {
      console.log(`Page ${page} has no videos — stopping.`);
      break;
    }
    console.log(`\n=== Page ${page}: ${cards.length} videos (${pageUrl(page)}) ===`);
    for (const card of cards) {
      const label = `[page ${page}] [#${++count}]`;
      try {
        await processVideo(card, done, label);
      } catch (err) {
        console.error(`${label} FAILED ${card.url}: ${err.message}`);
        failures.push({ page, url: card.url, error: err.message });
      }
      await sleep(500);
    }
  }

  console.log(`\nDone. Processed ${count} videos, ${failures.length} failure(s).`);
  for (const f of failures) console.log(`  page ${f.page}: ${f.url} — ${f.error}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
