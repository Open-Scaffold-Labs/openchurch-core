-- X-6 backup reader role (R370-4). Primary recipe: public-schema SELECT only.
-- Run as the role that owns/creates the app tables (normally `postgres`).
-- Set the password separately: ALTER ROLE oc_backup_ro PASSWORD '<from your password manager>';
-- No pg_read_all_data, no write grants, no role management, not a superuser.
CREATE ROLE oc_backup_ro LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
ALTER ROLE oc_backup_ro SET default_transaction_read_only = on;
REVOKE ALL ON SCHEMA public FROM oc_backup_ro;
GRANT USAGE ON SCHEMA public TO oc_backup_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO oc_backup_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO oc_backup_ro;
-- Tables created later by the migration role stay readable. Repeat this pair
-- FOR ROLE <each role that creates tables in public> if there is more than one.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO oc_backup_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON SEQUENCES TO oc_backup_ro;
