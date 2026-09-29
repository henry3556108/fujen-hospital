-- WP7：Wiki.js 的資料庫。pg_trgm 是 Wiki.js PostgreSQL 檢索引擎需要的外掛。
CREATE DATABASE wiki;
\c wiki
CREATE EXTENSION IF NOT EXISTS pg_trgm;
