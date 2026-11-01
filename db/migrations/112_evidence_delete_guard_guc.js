/**
 * Migration 112: authorized escape hatch for the financial replay evidence
 * retention guard on economy_daily_assessments.
 *
 * The retention triggers (added by the economy-money work) make the table
 * append-only so replay evidence is never lost to accidents, cron jobs, or
 * casual admin actions. That guard also blocked the owner-initiated
 * "delete server" flow, which legitimately removes a server's own history
 * at the owner's explicit request.
 *
 * The delete trigger function now allows deletion only when the session GUC
 * `dayz.authorized_server_deletion` is set to 'on' — which the admin
 * server-delete endpoint sets via SET LOCAL inside its own transaction.
 * Every other code path (cron, shell, other routes) still hits the guard.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 112: authorized server-deletion escape hatch for evidence retention');

  await pool.query(`
    CREATE OR REPLACE FUNCTION protect_financial_replay_evidence_delete()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('dayz.authorized_server_deletion', true) = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'Cannot delete financial replay evidence from %', TG_TABLE_NAME;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql
  `);

  console.log('✅ Migration 112 complete');
}

module.exports = { up };
