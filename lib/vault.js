// Encrypted profiles. Each profile has its own password.
//
// How it works:
// - Each profile has a random 256-bit data key. Everything saved for the profile (details, signature,
//   forms and drafts) is encrypted with it using AES-256-GCM.
// - The data key itself is stored twice, each copy encrypted ("wrapped"): once with a key made from your
//   password, once with a key made from your recovery code. Both use scrypt, which is slow on purpose so
//   passwords cannot be guessed quickly.
// - The password and recovery code are never stored. Without one of them, nothing can be read.
// - When you unlock, the data key is kept in this server's memory for your browser session only,
//   and forgotten when you lock, after 15 minutes without use, or when the server stops.
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile, readdir, rm, mkdir, rename } from 'node:fs/promises';
import { dataPath } from './data.js';
import { userError } from './system.js';

const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 512 * 1024 * 1024 };
const IDLE_MS = 15 * 60 * 1000;

function scrypt(secret, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret.normalize('NFKC'), salt, 32, KDF, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from('CW1'), iv, c.getAuthTag(), ct]);
}

function open(key, blob, aad) {
  if (blob.subarray(0, 3).toString() !== 'CW1') throw new Error('Unknown file format');
  const iv = blob.subarray(3, 15);
  const tag = blob.subarray(15, 31);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(31)), d.final()]);
}

async function root() {
  return dataPath('profiles');
}

async function profileDir(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw userError('Unknown profile.');
  return path.join(await root(), id);
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, file);
}

/** Lists profiles: only their id and name (names are not secret). */
export async function listProfiles() {
  const out = [];
  for (const id of await readdir(await root()).catch(() => [])) {
    try {
      const meta = JSON.parse(await readFile(path.join(await root(), id, 'meta.json'), 'utf8'));
      out.push({ id: meta.id, name: meta.name });
    } catch { /* not a profile */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function recoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(24);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s.match(/.{4}/g).join('-');
}

function cleanCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function wrap(secret, dataKey, label) {
  const salt = crypto.randomBytes(16);
  const kek = await scrypt(secret, salt);
  return { salt: salt.toString('base64'), box: seal(kek, dataKey, label).toString('base64') };
}

async function unwrap(secret, w, label) {
  const kek = await scrypt(secret, Buffer.from(w.salt, 'base64'));
  return open(kek, Buffer.from(w.box, 'base64'), label);
}

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw userError('Use a password of at least 10 characters. A few random words works well.');
}

/** Makes a new profile. Returns { id, recovery } — show the recovery code once. */
export async function createProfile(name, password) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw userError('Type a name for the profile, for example your first name.');
  checkPassword(password);
  if ((await listProfiles()).some((p) => p.name.toLowerCase() === name.toLowerCase())) throw userError('There is already a profile with that name.');
  const id = crypto.randomBytes(8).toString('hex');
  const dataKey = crypto.randomBytes(32);
  const recovery = recoveryCode();
  const meta = {
    id, name, version: 1, created: new Date().toISOString(),
    kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p },
    password: await wrap(password, dataKey, `pw:${id}`),
    recovery: await wrap(cleanCode(recovery), dataKey, `rc:${id}`),
  };
  const dir = await profileDir(id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  const v = new Vault(id, name, dataKey);
  await v.putJson('profile', { fields: {}, custom: [] });
  return { id, recovery, vault: v };
}

const failures = new Map(); // id -> { count, until }

async function readMeta(id) {
  try {
    return JSON.parse(await readFile(path.join(await profileDir(id), 'meta.json'), 'utf8'));
  } catch {
    throw userError('That profile does not exist.');
  }
}

/** Unlocks with the password, or with the recovery code (then a new password must be set). */
export async function unlockProfile(id, secret, { recovery = false, newPassword = null } = {}) {
  const f = failures.get(id);
  if (f && f.until > Date.now()) throw userError(`Too many wrong tries. Wait ${Math.ceil((f.until - Date.now()) / 1000)} seconds and try again.`);
  const meta = await readMeta(id);
  let dataKey;
  try {
    dataKey = recovery
      ? await unwrap(cleanCode(secret), meta.recovery, `rc:${id}`)
      : await unwrap(String(secret || ''), meta.password, `pw:${id}`);
  } catch {
    const n = (f?.count || 0) + 1;
    failures.set(id, { count: n, until: n >= 5 ? Date.now() + Math.min(15 * 60, 2 ** (n - 4) * 15) * 1000 : 0 });
    throw userError(recovery ? 'That recovery code is not right.' : 'That password is not right.');
  }
  failures.delete(id);
  if (recovery) {
    checkPassword(newPassword);
    meta.password = await wrap(newPassword, dataKey, `pw:${id}`);
    await writeAtomic(path.join(await profileDir(id), 'meta.json'), JSON.stringify(meta, null, 2));
  }
  return new Vault(id, meta.name, dataKey);
}

/** Changes the password of an unlocked profile. */
export async function changePassword(vault, newPassword) {
  checkPassword(newPassword);
  const meta = await readMeta(vault.id);
  meta.password = await wrap(newPassword, vault.key, `pw:${vault.id}`);
  await writeAtomic(path.join(await profileDir(vault.id), 'meta.json'), JSON.stringify(meta, null, 2));
}

export async function deleteProfile(vault) {
  await rm(await profileDir(vault.id), { recursive: true, force: true });
}

/** An unlocked profile: read and write encrypted items by name. */
export class Vault {
  constructor(id, name, key) {
    this.id = id;
    this.name = name;
    this.key = key;
  }

  async file(item) {
    if (!/^[\w.-]{1,80}$/.test(item)) throw new Error(`Bad item name ${item}`);
    return path.join(await profileDir(this.id), `${item}.enc`);
  }

  async put(item, buffer) {
    await writeAtomic(await this.file(item), seal(this.key, Buffer.from(buffer), `${this.id}:${item}`));
  }

  async get(item) {
    let blob;
    try {
      blob = await readFile(await this.file(item));
    } catch {
      return null;
    }
    return open(this.key, blob, `${this.id}:${item}`);
  }

  async remove(item) {
    await rm(await this.file(item), { force: true });
  }

  async putJson(item, value) {
    await this.put(item, JSON.stringify(value));
  }

  async getJson(item, fallback = null) {
    const b = await this.get(item);
    return b ? JSON.parse(b.toString('utf8')) : fallback;
  }
}

// ---- Browser sessions ----

const sessions = new Map(); // token -> { vault, last, flash }

export function newSession(vault) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { vault, last: Date.now(), flash: null });
  return token;
}

function tokenFrom(req) {
  const m = /(?:^|;\s*)cw_session=([\w-]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

/** The unlocked profile for this browser, or null. Using it keeps it unlocked for another 15 minutes. */
export function sessionFor(req) {
  const t = tokenFrom(req);
  const s = t && sessions.get(t);
  if (!s) return null;
  if (Date.now() - s.last > IDLE_MS) {
    sessions.delete(t);
    return null;
  }
  s.last = Date.now();
  return s;
}

export function endSession(req) {
  const t = tokenFrom(req);
  if (t) sessions.delete(t);
}

export function cookieFor(token) {
  return `cw_session=${token}; Path=/; HttpOnly; SameSite=Strict${process.env.SECURE_COOKIES === '1' ? '; Secure' : ''}`;
}

export const clearCookie = 'cw_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';

setInterval(() => {
  for (const [t, s] of sessions) if (Date.now() - s.last > IDLE_MS) sessions.delete(t);
}, 60 * 1000).unref();
