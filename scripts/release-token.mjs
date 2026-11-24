// The owner hands out and takes back release tokens: with one, a team member's release.sh
// publishes app builds to every machine (POST /v1/releases/:flavor) with no Render access and
// no owner database login. Only the token's SHA-256 is stored; the token is shown once.
//   DATABASE_URL_DIRECT=… npm run release-token -- create <name> [flavors]    (prints the token)
//     flavors: comma-separated, e.g. pos2 for a Mandi Plus 2-only token; default pos,daybook,pos2
//   DATABASE_URL_DIRECT=… npm run release-token -- list
//   DATABASE_URL_DIRECT=… npm run release-token -- revoke <name>
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const [cmd, name, flavorList] = process.argv.slice(2);
const url = process.env.DATABASE_URL_DIRECT;
if (!url || !['create', 'list', 'revoke'].includes(cmd) || (cmd !== 'list' && !name)) {
  console.error('Usage: DATABASE_URL_DIRECT=… npm run release-token -- create <name> [flavors] | list | revoke <name>');
  process.exit(1);
}
// The flavors POST /v1/releases/:flavor publishes (release-publish.controller.ts).
const PUBLISHABLE = ['pos', 'daybook', 'pos2'];
const flavors = flavorList ? flavorList.split(',').map((f) => f.trim()).filter(Boolean) : null;
if (flavors && (!flavors.length || flavors.some((f) => !PUBLISHABLE.includes(f)))) {
  console.error(`Flavors must be from ${PUBLISHABLE.join(',')}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (cmd === 'create') {
    const token = `mpr_${randomBytes(32).toString('base64url')}`;
    const hash = createHash('sha256').update(token).digest();
    const { rows } = flavors
      ? await client.query(`INSERT INTO release_publishers (name, token_sha256, flavors) VALUES ($1, $2, $3) RETURNING flavors`, [name, hash, flavors])
      : await client.query(`INSERT INTO release_publishers (name, token_sha256) VALUES ($1, $2) RETURNING flavors`, [name, hash]);
    console.log(`Release token for ${name}, may publish ${rows[0].flavors.join(',')} (shown once; send it privately):\n${token}`);
  } else if (cmd === 'revoke') {
    const r = await client.query(`UPDATE release_publishers SET revoked_at = now() WHERE name = $1 AND revoked_at IS NULL`, [name]);
    console.log(r.rowCount ? `Revoked ${r.rowCount} token(s) of ${name}` : `${name} has no live token`);
  } else {
    const { rows } = await client.query(`SELECT name, flavors, created_at, last_used_at, revoked_at FROM release_publishers ORDER BY created_at`);
    for (const r of rows) {
      console.log(`${r.name.padEnd(12)} ${r.revoked_at ? 'REVOKED' : 'live   '} ${r.flavors.join(',')}  made ${r.created_at.toISOString().slice(0, 10)}  last used ${r.last_used_at?.toISOString().slice(0, 16) ?? '—'}`);
    }
  }
} finally {
  await client.end();
}
