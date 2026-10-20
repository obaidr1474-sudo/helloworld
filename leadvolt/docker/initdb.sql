-- Runs once when the Postgres container is first created.
CREATE ROLE leadvolt_app LOGIN PASSWORD 'leadvolt_app';
GRANT CONNECT ON DATABASE leadvolt TO leadvolt_app;
\connect leadvolt
GRANT USAGE ON SCHEMA public TO leadvolt_app;
ALTER DEFAULT PRIVILEGES FOR ROLE leadvolt IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO leadvolt_app;
ALTER DEFAULT PRIVILEGES FOR ROLE leadvolt IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO leadvolt_app;

-- Separate worker principal; replace development passwords for deployed databases.
CREATE ROLE leadvolt_worker LOGIN PASSWORD 'leadvolt_worker';
GRANT CONNECT ON DATABASE leadvolt TO leadvolt_worker;
GRANT USAGE ON SCHEMA public TO leadvolt_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE leadvolt IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO leadvolt_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE leadvolt IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO leadvolt_worker;
