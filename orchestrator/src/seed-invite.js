import { DB } from './db.js';
import { config } from './config.js';

const code = process.argv[2];
if (!code) {
  console.error('Usage: npm run seed:invite -- <CODE> [max_uses] [expires_at_iso]');
  process.exit(1);
}

const maxUses = Number(process.argv[3] || 1);
const expiresAt = process.argv[4] || null;

const db = new DB(config.dataDir);
const invite = db.ensureInvite({
  code,
  maxUses,
  expiresAt
});

console.log('invite ready:', invite);
