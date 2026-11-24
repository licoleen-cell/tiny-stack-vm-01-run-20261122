import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Opcode -> immediate bytes / pops / pushes, packed as imm*16 + pops*4 + pushes. S holds the 14 distinct signatures and
// T indexes them by an 84-char base-36 string ('.' = no such opcode); packed to keep the repo under its 8,192-byte cap.
const S = [0,17,65,4,6,10,11,15,9,5,32,36,8,1];
const T = [...'01234567........888888898889888.888.............abba0...........9c..............33d3'].map(
  (c) => (c === '.' ? -1 : S[parseInt(c, 36)]),
);

/** Runs one program to its end: the bytes it wrote and its exit code (a trap's own code), in ISA.md's order. */
function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const n = p.length;
  const D = new Int32Array(256);
  const M = new Int32Array(256);
  const C = new Int32Array(64);
  const out = new Uint8Array(65536);
  let sp = 0, csp = 0, ip = 0, pc = 0, olen = 0, steps = 0;
  const done = (code: number) => ({ out: out.subarray(0, olen), code });
  for (;;) {
    if (steps === 1e6) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const t = T[p[pc]];
    if (!(t >= 0)) return done(5);
    const op = p[pc];
    const imm = t >> 4;
    if (pc + imm >= n) return done(9);
    steps++;
    const nx = pc + imm + 1;
    const pops = (t >> 2) & 3;
    if (sp < pops) return done(2);
    sp += (t & 3) - pops;
    if (sp > 256) return done(3);
    pc = nx;
    if (op > 0xf && op < 0x23 && op !== 0x17 && op !== 0x1b) {
      const b = D[sp];
      const a = D[sp - 1];
      let r: number;
      if (op < 0x17) {
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (b === 0) return done(4);
        else if (op === 0x13) r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        else if (op === 0x14) r = b === -1 ? 0 : (a % b) | 0;
        else if (op === 0x15) r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        else r = ((a >>> 0) % (b >>> 0)) | 0;
      } else if (op === 0x21) r = a < b ? 1 : 0;
      else if (op === 0x22) r = (a >>> 0) < (b >>> 0) ? 1 : 0;
      else if (op === 0x20) r = a === b ? 1 : 0;
      else if (op === 0x1c) r = a << (b & 31);
      else if (op === 0x1d) r = a >> (b & 31);
      else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
      else if (op === 0x18) r = a & b;
      else if (op === 0x19) r = a | b;
      else r = a ^ b;
      D[sp - 1] = r;
      continue;
    }
    switch (op) {
      case 0: return done(0);
      case 1: D[sp - 1] = (p[nx - 1] << 24) >> 24; break;
      case 2: D[sp - 1] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24); break;
      case 3: break;
      case 4: D[sp - 1] = D[sp - 2]; break;
      case 5: { const x = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = x; break; }
      case 6: D[sp - 1] = D[sp - 3]; break;
      case 7: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; }
      case 0x17: D[sp - 1] = -D[sp - 1] | 0; break;
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break;
      case 0x30: case 0x31: case 0x32: {
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        if (op === 0x30) pc = nx + rel;
        else if ((D[sp] === 0) === (op === 0x31)) pc = nx + rel;
        break;
      }
      case 0x33:
        if (csp === 64) return done(7);
        C[csp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34:
        if (csp === 0) return done(8);
        pc = C[--csp];
        break;
      case 0x40: {
        const a = D[sp - 1];
        if (a < 0 || a > 255) return done(6);
        D[sp - 1] = M[a];
        break;
      }
      case 0x41: {
        const a = D[sp + 1], v = D[sp];
        if (a < 0 || a > 255) return done(6);
        M[a] = v;
        break;
      }
      case 0x50: {
        const s = String(D[sp]);
        if (olen + s.length > 65536) return done(11);
        for (let k = 0; k < s.length; k++) out[olen++] = s.charCodeAt(k);
        break;
      }
      case 0x51:
        if (olen === 65536) return done(11);
        out[olen++] = D[sp] & 255;
        break;
      case 0x52: D[sp - 1] = ip < inp.length ? inp[ip++] : -1; break;
      default: return done(D[sp] & 255);
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(new Uint8Array(readFileSync(join(I, id, 'program.bin'))), new Uint8Array(readFileSync(join(I, id, 'input.bin'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
