"use strict";

// Same scrypt settings as Node's crypto.scryptSync: N=16384, r=8, p=1.
(function (root) {
  function rotl(value, bits) {
    return ((value << bits) | (value >>> (32 - bits))) >>> 0;
  }

  function sha256(bytes) {
    const k = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const bitLength = bytes.length * 8;
    const withPad = new Uint8Array(((bytes.length + 9 + 63) & ~63));
    withPad.set(bytes);
    withPad[bytes.length] = 0x80;
    const view = new DataView(withPad.buffer);
    view.setUint32(withPad.length - 4, bitLength >>> 0, false);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let offset = 0; offset < withPad.length; offset += 64) {
      for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotl(w[i - 15], 25) ^ rotl(w[i - 15], 14) ^ (w[i - 15] >>> 3);
        const s1 = rotl(w[i - 2], 15) ^ rotl(w[i - 2], 13) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i += 1) {
        const s1 = rotl(e, 26) ^ rotl(e, 21) ^ rotl(e, 7);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + ch + k[i] + w[i]) >>> 0;
        const s0 = rotl(a, 30) ^ rotl(a, 19) ^ rotl(a, 10);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, index) => outView.setUint32(index * 4, word, false));
    return out;
  }

  function hmac(key, message) {
    const block = 64;
    let normalized = key;
    if (normalized.length > block) normalized = sha256(normalized);
    const padded = new Uint8Array(block);
    padded.set(normalized);
    const outer = new Uint8Array(block);
    const inner = new Uint8Array(block);
    for (let i = 0; i < block; i += 1) {
      outer[i] = padded[i] ^ 0x5c;
      inner[i] = padded[i] ^ 0x36;
    }
    const innerData = new Uint8Array(block + message.length);
    innerData.set(inner);
    innerData.set(message, block);
    const innerHash = sha256(innerData);
    const outerData = new Uint8Array(block + innerHash.length);
    outerData.set(outer);
    outerData.set(innerHash, block);
    return sha256(outerData);
  }

  function pbkdf2(password, salt, iterations, length) {
    const blocks = Math.ceil(length / 32);
    const out = new Uint8Array(blocks * 32);
    for (let block = 1; block <= blocks; block += 1) {
      const seed = new Uint8Array(salt.length + 4);
      seed.set(salt);
      new DataView(seed.buffer).setUint32(salt.length, block, false);
      let u = hmac(password, seed);
      const t = u.slice();
      for (let i = 1; i < iterations; i += 1) {
        u = hmac(password, u);
        for (let j = 0; j < t.length; j += 1) t[j] ^= u[j];
      }
      out.set(t, (block - 1) * 32);
    }
    return out.slice(0, length);
  }

  function salsa(input) {
    const x = input.slice();
    for (let round = 0; round < 4; round += 1) {
      x[4] ^= rotl((x[0] + x[12]) >>> 0, 7);
      x[8] ^= rotl((x[4] + x[0]) >>> 0, 9);
      x[12] ^= rotl((x[8] + x[4]) >>> 0, 13);
      x[0] ^= rotl((x[12] + x[8]) >>> 0, 18);
      x[9] ^= rotl((x[5] + x[1]) >>> 0, 7);
      x[13] ^= rotl((x[9] + x[5]) >>> 0, 9);
      x[1] ^= rotl((x[13] + x[9]) >>> 0, 13);
      x[5] ^= rotl((x[1] + x[13]) >>> 0, 18);
      x[14] ^= rotl((x[10] + x[6]) >>> 0, 7);
      x[2] ^= rotl((x[14] + x[10]) >>> 0, 9);
      x[6] ^= rotl((x[2] + x[14]) >>> 0, 13);
      x[10] ^= rotl((x[6] + x[2]) >>> 0, 18);
      x[3] ^= rotl((x[15] + x[11]) >>> 0, 7);
      x[7] ^= rotl((x[3] + x[15]) >>> 0, 9);
      x[11] ^= rotl((x[7] + x[3]) >>> 0, 13);
      x[15] ^= rotl((x[11] + x[7]) >>> 0, 18);
      x[1] ^= rotl((x[0] + x[3]) >>> 0, 7);
      x[2] ^= rotl((x[1] + x[0]) >>> 0, 9);
      x[3] ^= rotl((x[2] + x[1]) >>> 0, 13);
      x[0] ^= rotl((x[3] + x[2]) >>> 0, 18);
      x[6] ^= rotl((x[5] + x[4]) >>> 0, 7);
      x[7] ^= rotl((x[6] + x[5]) >>> 0, 9);
      x[4] ^= rotl((x[7] + x[6]) >>> 0, 13);
      x[5] ^= rotl((x[4] + x[7]) >>> 0, 18);
      x[11] ^= rotl((x[10] + x[9]) >>> 0, 7);
      x[8] ^= rotl((x[11] + x[10]) >>> 0, 9);
      x[9] ^= rotl((x[8] + x[11]) >>> 0, 13);
      x[10] ^= rotl((x[9] + x[8]) >>> 0, 18);
      x[12] ^= rotl((x[15] + x[14]) >>> 0, 7);
      x[13] ^= rotl((x[12] + x[15]) >>> 0, 9);
      x[14] ^= rotl((x[13] + x[12]) >>> 0, 13);
      x[15] ^= rotl((x[14] + x[13]) >>> 0, 18);
    }
    for (let i = 0; i < 16; i += 1) x[i] = (x[i] + input[i]) >>> 0;
    return x;
  }

  function blockMix(block, r) {
    const output = new Uint32Array(block.length);
    let x = block.slice(block.length - 16);
    for (let i = 0; i < 2 * r; i += 1) {
      for (let j = 0; j < 16; j += 1) x[j] ^= block[i * 16 + j];
      x = salsa(x);
      output.set(x, i * 16);
    }
    const mixed = new Uint32Array(block.length);
    for (let i = 0; i < r; i += 1) {
      mixed.set(output.subarray(i * 32, i * 32 + 16), i * 16);
      mixed.set(output.subarray(i * 32 + 16, i * 32 + 32), (i + r) * 16);
    }
    return mixed;
  }

  function integerify(block) {
    return block[block.length - 16];
  }

  function romix(block, r, n) {
    const memory = [block.slice()];
    for (let i = 0; i < n - 1; i += 1) memory.push(blockMix(memory[i], r));
    let x = blockMix(memory[n - 1], r);
    for (let i = 0; i < n; i += 1) {
      const j = integerify(x) % n;
      const mixed = x.slice();
      for (let k = 0; k < x.length; k += 1) mixed[k] ^= memory[j][k];
      x = blockMix(mixed, r);
    }
    return x;
  }

  function bytesToWords(bytes) {
    const words = new Uint32Array(bytes.length / 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < words.length; i += 1) words[i] = view.getUint32(i * 4, true);
    return words;
  }

  function wordsToBytes(words) {
    const bytes = new Uint8Array(words.length * 4);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < words.length; i += 1) view.setUint32(i * 4, words[i], true);
    return bytes;
  }

  function scrypt(password, salt, n, r, p, length) {
    const encoder = new TextEncoder();
    const passwordBytes = encoder.encode(password);
    const saltBytes = typeof salt === "string" ? encoder.encode(salt) : salt;
    const derived = pbkdf2(passwordBytes, saltBytes, 1, p * 128 * r);
    const blocks = [];
    for (let i = 0; i < p; i += 1) {
      const piece = derived.subarray(i * 128 * r, (i + 1) * 128 * r);
      blocks.push(romix(bytesToWords(piece), r, n));
    }
    const mixed = new Uint8Array(p * 128 * r);
    blocks.forEach((block, index) => mixed.set(wordsToBytes(block), index * 128 * r));
    return pbkdf2(passwordBytes, mixed, 1, length);
  }

  root.ariesScrypt = scrypt;
})(typeof globalThis !== "undefined" ? globalThis : this);
