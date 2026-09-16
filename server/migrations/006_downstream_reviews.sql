USE vendor_onboarding;
-- Run once on an existing database. Back up your demo database first.
ALTER TABLE onboarding_tickets ADD COLUMN workflow_stage ENUM('VENDOR','LOCAL','TRANSLATION','INDIA','SECURITY','LOCAL_REWORK','COMPLETED') NOT NULL DEFAULT 'VENDOR';
ALTER TABLE ticket_documents
  ADD COLUMN india_status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN security_status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING';
ALTER TABLE document_review_events
  MODIFY COLUMN decision ENUM('LOCAL_PROCUREMENT_ACCEPTED','INDIA_PROCUREMENT_ACCEPTED','SECURITY_ACCEPTED','REJECTED') NOT NULL,
  ADD COLUMN review_stage ENUM('LOCAL','INDIA','SECURITY') NOT NULL DEFAULT 'LOCAL';
CREATE TABLE IF NOT EXISTS workflow_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  stage VARCHAR(30) NOT NULL,
  action VARCHAR(40) NOT NULL,
  actor_email VARCHAR(254) NOT NULL,
  details JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_workflow_ticket FOREIGN KEY (ticket_id) REFERENCES onboarding_tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB;
UPDATE onboarding_tickets SET workflow_stage=CASE status WHEN 'DOCUMENTS_UPLOADED' THEN 'LOCAL' WHEN 'LOCAL_PROCUREMENT_ACCEPTED' THEN 'TRANSLATION' ELSE 'VENDOR' END;
-- Existing completed translations advance on backend startup. No historic request
-- is assumed to have India or Security approval.
