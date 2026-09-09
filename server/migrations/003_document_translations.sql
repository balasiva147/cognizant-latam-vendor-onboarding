USE vendor_onboarding;

CREATE TABLE IF NOT EXISTS document_translations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_upload_id BIGINT UNSIGNED NOT NULL,
  target_language VARCHAR(10) NOT NULL DEFAULT 'EN-US',
  provider VARCHAR(30) NOT NULL DEFAULT 'DEEPL',
  status ENUM('PENDING','PROCESSING','COMPLETED','FAILED') NOT NULL DEFAULT 'PENDING',
  provider_document_id VARCHAR(255) NULL,
  translated_file_name VARCHAR(255) NULL,
  storage_path VARCHAR(700) NULL,
  mime_type VARCHAR(150) NULL,
  size_bytes BIGINT UNSIGNED NULL,
  sha256 CHAR(64) NULL,
  billed_characters BIGINT UNSIGNED NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(2000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_upload_target_language (document_upload_id, target_language),
  KEY idx_translation_status (status, created_at),
  CONSTRAINT fk_translation_upload FOREIGN KEY (document_upload_id) REFERENCES document_uploads(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;
