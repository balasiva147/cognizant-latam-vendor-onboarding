USE vendor_onboarding;

ALTER TABLE vendors
  ADD COLUMN authorized_person_name VARCHAR(200) NULL AFTER legal_name;

UPDATE vendors
SET authorized_person_name = 'Not provided (legacy)'
WHERE authorized_person_name IS NULL;

ALTER TABLE vendors
  MODIFY COLUMN authorized_person_name VARCHAR(200) NOT NULL;
