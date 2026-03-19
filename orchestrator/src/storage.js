import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function safeName(name) {
  return String(name || 'file.bin')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

export class Storage {
  constructor(dataDir) {
    this.base = path.resolve(dataDir, 'files');
    fs.mkdirSync(this.base, { recursive: true });
  }

  userDir(userId) {
    return path.join(this.base, userId);
  }

  async saveBuffer({ userId, category, originalName, buffer }) {
    const categorySafe = safeName(category || 'misc');
    const userRoot = this.userDir(userId);
    const targetDir = path.join(userRoot, categorySafe);
    await fsp.mkdir(targetDir, { recursive: true });
    const fileName = `${Date.now()}-${randomUUID()}-${safeName(originalName)}`;
    const fullPath = path.join(targetDir, fileName);
    await fsp.writeFile(fullPath, buffer);
    return {
      path: fullPath,
      filename: safeName(originalName)
    };
  }

  async writeText({ userId, category, originalName, text }) {
    return this.saveBuffer({
      userId,
      category,
      originalName,
      buffer: Buffer.from(text, 'utf8')
    });
  }

  async readFile(filePath) {
    return fsp.readFile(filePath);
  }
}
