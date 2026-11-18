// The album and track number from an audio file's own tags (MP3 ID3v2, M4A/M4B), for putting an album's songs in
// order when the file names don't. Reads only what it needs; anything it can't read gives null.
'use strict';
const fs = require('fs');

function text(buf, enc) {
  if (enc === 1 || enc === 2) { // UTF-16 (with a byte-order mark) or UTF-16BE
    let b = buf, le = enc === 1;
    if (b[0] === 0xff && b[1] === 0xfe) { le = true; b = b.slice(2); } else if (b[0] === 0xfe && b[1] === 0xff) { le = false; b = b.slice(2); }
    if (!le) { const s = Buffer.from(b); for (let i = 0; i + 1 < s.length; i += 2) { const t = s[i]; s[i] = s[i + 1]; s[i + 1] = t; } b = s; }
    return b.toString('utf16le').replace(/\0+$/, '');
  }
  return buf.toString(enc === 3 ? 'utf8' : 'latin1').replace(/\0+$/, '');
}

function id3(fd) {
  const h = Buffer.alloc(10);
  if (fs.readSync(fd, h, 0, 10, 0) < 10 || h.toString('latin1', 0, 3) !== 'ID3') return null;
  const v = h[3], size = (h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9];
  const b = Buffer.alloc(Math.min(size, 1 << 20));
  fs.readSync(fd, b, 0, b.length, 10);
  let i = 0, album = '', track = 0;
  if (h[5] & 0x40) i += v === 4 ? ((b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]) : (b.readUInt32BE(0) + 4); // extended header
  while (i + 10 <= b.length) {
    const id = b.toString('latin1', i, i + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const n = v === 4 ? ((b[i + 4] << 21) | (b[i + 5] << 14) | (b[i + 6] << 7) | b[i + 7]) : b.readUInt32BE(i + 4);
    const data = b.slice(i + 10, i + 10 + n);
    if (id === 'TALB') album = text(data.slice(1), data[0]);
    if (id === 'TRCK') track = parseInt(text(data.slice(1), data[0]), 10) || 0;
    i += 10 + n;
  }
  return track ? { album, track } : null;
}

function mp4(fd, fileSize) {
  const head = Buffer.alloc(16);
  const atoms = (start, end, cb) => { // calls cb(type, dataStart, dataEnd) for each atom in [start, end)
    let p = start;
    while (p + 8 <= end) {
      if (fs.readSync(fd, head, 0, 16, p) < 8) return;
      let size = head.readUInt32BE(0), hl = 8;
      const type = head.toString('latin1', 4, 8);
      if (size === 1) { size = Number(head.readBigUInt64BE(8)); hl = 16; } else if (size === 0) size = end - p;
      if (size < hl) return;
      if (cb(type, p + hl, p + size) === false) return;
      p += size;
    }
  };
  let ilst = null;
  atoms(0, fileSize, (t, s, e) => {
    if (t !== 'moov') return;
    atoms(s, e, (t2, s2, e2) => {
      if (t2 !== 'udta') return;
      atoms(s2, e2, (t3, s3, e3) => { if (t3 === 'meta') atoms(s3 + 4, e3, (t4, s4, e4) => { if (t4 === 'ilst') ilst = [s4, e4]; }); });
    });
    return false;
  });
  if (!ilst) return null;
  let album = '', track = 0;
  atoms(ilst[0], ilst[1], (t, s, e) => {
    if (t !== '©alb' && t !== 'trkn') return;
    atoms(s, e, (t2, s2, e2) => {
      if (t2 !== 'data') return;
      const b = Buffer.alloc(Math.min(e2 - s2, 4096));
      fs.readSync(fd, b, 0, b.length, s2);
      if (t === 'trkn') track = b.length >= 12 ? b.readUInt16BE(10) : 0; // 8 bytes type/locale, 2 padding, then the number
      else album = b.slice(8).toString('utf8');
    });
  });
  return track ? { album, track } : null;
}

// Ogg Opus / Vorbis (some downloads are these, named .mp3): "ALBUM=" and "TRACKNUMBER=" in the comment header
function ogg(fd) {
  const b = Buffer.alloc(1 << 16);
  const n = fs.readSync(fd, b, 0, b.length, 0);
  let i = b.indexOf('OpusTags'), skip = 8;
  if (i < 0 || i > n) { i = b.indexOf('\x03vorbis', 0, 'latin1'); skip = 7; }
  if (i < 0 || i > n) return null;
  let p = i + skip;
  const u32 = () => { const v = b.readUInt32LE(p); p += 4; return v; };
  try {
    const vendor = u32(); p += vendor; // (not "p += u32()": that adds to p as it was before reading)
    let album = '', track = 0;
    for (let k = u32(); k > 0 && p < n; k--) {
      const len = u32(), s = b.toString('utf8', p, p + len); p += len;
      const eq = s.indexOf('='), key = s.slice(0, eq).toUpperCase(), val = s.slice(eq + 1);
      if (key === 'ALBUM') album = val;
      if (key === 'TRACKNUMBER') track = parseInt(val, 10) || 0;
    }
    return track ? { album, track } : null;
  } catch { return null; }
}

/** { album, track } from the file's tags, or null. Goes by what's in the file, not its name. */
module.exports = function albumTrack(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const h = Buffer.alloc(12);
    fs.readSync(fd, h, 0, 12, 0);
    if (h.toString('latin1', 0, 3) === 'ID3') return id3(fd);
    if (h.toString('latin1', 0, 4) === 'OggS') return ogg(fd);
    if (h.toString('latin1', 4, 8) === 'ftyp') return mp4(fd, fs.fstatSync(fd).size);
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
};
