ALTER TABLE publication_runs ADD COLUMN actor TEXT;
ALTER TABLE publication_runs ADD COLUMN workflow TEXT;
ALTER TABLE publication_runs ADD COLUMN before_checksum TEXT;
ALTER TABLE publication_runs ADD COLUMN after_checksum TEXT;
