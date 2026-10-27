import { readFile } from 'node:fs/promises';
import { fail } from '../../../../shared/errors.js';

export async function migrateAuth(pool) {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
}

export function userRepository(pool) {
  return {
    async create(user, passwordHash) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          'INSERT INTO users(username,password,roleid,email,phone) VALUES($1,$2,1,$3,$4) RETURNING uid,username',
          [user.username, passwordHash, user.email, user.phone],
        );
        await client.query('INSERT INTO auth_provisioning(uid,fullname) VALUES($1,$2)', [rows[0].uid, rows[0].username]);
        await client.query('COMMIT');
        return rows[0];
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error.code === '23505') fail(409, 'Username or email already exists');
        throw error;
      } finally { client.release(); }
    },
    async findByUsername(username) {
      const { rows } = await pool.query(
        'SELECT u.uid,u.username,u.password,r.rolename AS role FROM users u JOIN roles r ON r.roleid=u.roleid WHERE u.username=$1',
        [username],
      );
      return rows[0];
    },
    async findIdentity(uid) {
      const { rows } = await pool.query('SELECT u.uid,r.rolename AS role FROM users u JOIN roles r ON r.roleid=u.roleid WHERE u.uid=$1', [uid]);
      return rows[0];
    },
    async findProvisioning(uid) {
      const { rows } = await pool.query('SELECT uid,fullname,state FROM auth_provisioning WHERE uid=$1', [uid]);
      return rows[0];
    },
    async pendingProvisioning() {
      const { rows } = await pool.query("SELECT uid,fullname,state FROM auth_provisioning WHERE state='PENDING' AND next_attempt_at<=NOW() ORDER BY next_attempt_at LIMIT 20");
      return rows;
    },
    async provisioned(uid) {
      await pool.query("UPDATE auth_provisioning SET state='DONE',last_error=NULL WHERE uid=$1", [uid]);
    },
    async provisioningFailed(uid, error) {
      await pool.query("UPDATE auth_provisioning SET attempts=attempts+1,last_error=$2,next_attempt_at=NOW()+INTERVAL '2 seconds' WHERE uid=$1 AND state='PENDING'", [uid, String(error.message || 'Customer unavailable').slice(0, 500)]);
    },
  };
}
