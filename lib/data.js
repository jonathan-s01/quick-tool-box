// Where saved things (such as the menu library) are kept. Survives updates and restarts.
// Set DATA_DIR to change it. Docker uses /data.
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Before the rename the folder was cli-wrappers-data. If that one exists, keep using it.
const OLD_DIR = path.join(os.homedir(), 'cli-wrappers-data');
const NEW_DIR = path.join(os.homedir(), 'quick-tool-box-data');
export const DATA_DIR = process.env.DATA_DIR || (existsSync(OLD_DIR) && !existsSync(NEW_DIR) ? OLD_DIR : NEW_DIR);

export async function dataPath(...parts) {
  const dir = path.join(DATA_DIR, ...parts);
  await mkdir(dir, { recursive: true });
  return dir;
}
