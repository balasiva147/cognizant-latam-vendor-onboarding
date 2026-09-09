CREATE DATABASE IF NOT EXISTS vendor_onboarding
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE vendor_onboarding;

CREATE TABLE IF NOT EXISTS vendors (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  legal_name VARCHAR(200) NOT NULL,
  email VARCHAR(254) NOT NULL,
  registered_address VARCHAR(500) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vendors_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS onboarding_tickets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_number VARCHAR(30) NOT NULL,
  vendor_id BIGINT UNSIGNED NOT NULL,
  country_code CHAR(2) NOT NULL,
  communication_language VARCHAR(20) NOT NULL,
  status ENUM('INIT','DOCUMENTS_UPLOADED','LOCAL_PROCUREMENT_ACCEPTED')
    NOT NULL DEFAULT 'INIT',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ticket_number (ticket_number),
  KEY idx_ticket_vendor (vendor_id),
  KEY idx_ticket_status (status),
  CONSTRAINT fk_ticket_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ticket_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  document_name VARCHAR(200) NOT NULL,
  status ENUM('INIT','DOCUMENTS_UPLOADED','LOCAL_PROCUREMENT_ACCEPTED')
    NOT NULL DEFAULT 'INIT',
  rejection_reason VARCHAR(1000) NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ticket_document (ticket_id, document_name),
  KEY idx_ticket_document_status (ticket_id, status),
  CONSTRAINT fk_document_ticket FOREIGN KEY (ticket_id) REFERENCES onboarding_tickets(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

-- File bytes are stored outside MySQL. This table records every immutable upload
-- version, where it lives, and the SHA-256 needed for integrity verification.
CREATE TABLE IF NOT EXISTS document_uploads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_document_id BIGINT UNSIGNED NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  original_file_name VARCHAR(255) NOT NULL,
  stored_file_name VARCHAR(255) NOT NULL,
  storage_path VARCHAR(700) NOT NULL,
  mime_type VARCHAR(150) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  uploaded_by_email VARCHAR(254) NOT NULL,
  uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_document_version (ticket_document_id, version_number),
  KEY idx_upload_document (ticket_document_id),
  KEY idx_upload_sha256 (sha256),
  CONSTRAINT fk_upload_document FOREIGN KEY (ticket_document_id) REFERENCES ticket_documents(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS document_review_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_document_id BIGINT UNSIGNED NOT NULL,
  document_upload_id BIGINT UNSIGNED NULL,
  decision ENUM('LOCAL_PROCUREMENT_ACCEPTED','REJECTED') NOT NULL,
  review_note VARCHAR(1000) NULL,
  reviewed_by_email VARCHAR(254) NOT NULL,
  reviewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_review_document (ticket_document_id, reviewed_at),
  CONSTRAINT fk_review_document FOREIGN KEY (ticket_document_id) REFERENCES ticket_documents(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_review_upload FOREIGN KEY (document_upload_id) REFERENCES document_uploads(id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS vendor_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  vendor_id BIGINT UNSIGNED NOT NULL,
  notification_type ENUM('DOCUMENTS_REJECTED') NOT NULL,
  subject VARCHAR(250) NOT NULL,
  message VARCHAR(2000) NOT NULL,
  rejected_documents JSON NOT NULL,
  delivery_status ENUM('PENDING','SENT','FAILED','READ') NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMP NULL,
  read_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY idx_notification_vendor (vendor_id, delivery_status, created_at),
  KEY idx_notification_ticket (ticket_id, created_at),
  CONSTRAINT fk_notification_ticket FOREIGN KEY (ticket_id) REFERENCES onboarding_tickets(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_notification_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

-- Run these as an administrator after choosing a strong password. Keep the same
-- values in server/.env. Limit the account to this demo database.
-- CREATE USER IF NOT EXISTS 'vendor_app'@'localhost' IDENTIFIED BY 'replace_me';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_onboarding.* TO 'vendor_app'@'localhost';
-- FLUSH PRIVILEGES;
