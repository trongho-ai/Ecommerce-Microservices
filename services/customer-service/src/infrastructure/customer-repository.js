import { readFile } from 'node:fs/promises';
import { fail } from '../../../../shared/errors.js';

export async function migrateCustomer(pool) {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
}

export function customerRepository(pool) {
  return {
    async get(uid) {
      const { rows } = await pool.query('SELECT uid,fullname,mid FROM customers WHERE uid=$1', [uid]);
      if (!rows[0]) fail(404, 'Customer not found');
      return rows[0];
    },
    async membership(uid) {
      const { rows } = await pool.query('SELECT m.mid,m.mname,m.score FROM customers c JOIN memberships m ON m.mid=c.mid WHERE c.uid=$1', [uid]);
      if (!rows[0]) fail(404, 'Customer or membership not found');
      return rows[0];
    },
    async update(input) {
      try {
        const { rows } = await pool.query(
          'UPDATE customers SET fullname=COALESCE($2,fullname),mid=COALESCE($3,mid) WHERE uid=$1 RETURNING uid,fullname,mid',
          [input.uid, input.fullname ?? null, input.mid ?? null],
        );
        if (!rows[0]) fail(404, 'Customer not found');
        return rows[0];
      } catch (error) {
        if (error.code === '23503') fail(400, 'Membership does not exist');
        throw error;
      }
    },
    async ensure(input) {
      const { rows } = await pool.query(
        'INSERT INTO customers(uid,fullname,mid) VALUES($1,$2,1) ON CONFLICT(uid) DO UPDATE SET uid=EXCLUDED.uid RETURNING uid,fullname,mid',
        [input.uid, input.fullname],
      );
      return rows[0];
    },
  };
}
