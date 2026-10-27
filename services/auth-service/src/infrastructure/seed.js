import bcrypt from 'bcryptjs';
import { ROLES, validateRegistration } from '../domain/user.js';

// Caller supplies explicitly documented demo accounts. Existing real users are never overwritten.
export async function seedAuth(pool, accounts = []) {
  const result = [];
  for (const account of accounts) {
    const user = validateRegistration(account);
    const roleid = ROLES[account.role || 'CUSTOMER'];
    if (!roleid) throw new Error(`Invalid demo role for ${user.username}`);
    const hash = await bcrypt.hash(user.password, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        'INSERT INTO users(username,password,roleid,email,phone,is_demo) VALUES($1,$2,$3,$4,$5,TRUE) ON CONFLICT(username) DO NOTHING RETURNING uid',
        [user.username, hash, roleid, user.email, user.phone],
      );
      const { rows } = await client.query('SELECT uid,username,roleid,is_demo FROM users WHERE username=$1', [user.username]);
      const stored = rows[0];
      if (!stored.is_demo) throw new Error(`Demo username collides with an existing real account: ${user.username}`);
      if (stored.roleid !== roleid) throw new Error(`Existing demo role does not match: ${user.username}`);
      await client.query('INSERT INTO auth_provisioning(uid,fullname) VALUES($1,$2) ON CONFLICT(uid) DO NOTHING', [stored.uid, account.fullname || user.username]);
      await client.query('COMMIT');
      result.push({ uid: stored.uid, username: stored.username, role: account.role || 'CUSTOMER', created: inserted.rowCount === 1 });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return result;
}
