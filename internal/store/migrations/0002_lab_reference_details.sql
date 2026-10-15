-- Reference-range details as printed on the report, so a flag can be audited
-- and "< 5.7" style bounds are not treated as inclusive.
ALTER TABLE lab_results ADD COLUMN ref_low_exclusive  INTEGER NOT NULL DEFAULT 0 CHECK (ref_low_exclusive IN (0, 1));
ALTER TABLE lab_results ADD COLUMN ref_high_exclusive INTEGER NOT NULL DEFAULT 0 CHECK (ref_high_exclusive IN (0, 1));
ALTER TABLE lab_results ADD COLUMN ref_text    TEXT;   -- the range exactly as printed, e.g. "Homens 13,5 a 17,5"
ALTER TABLE lab_results ADD COLUMN report_flag TEXT;   -- the lab's own mark: H, L, crítico, *
