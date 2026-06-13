-- Promote TEXT (64 KB) to MEDIUMTEXT (16 MB) for columns that store
-- industrial PLC routine source/output (routinely >64 KB).
ALTER TABLE `translations` MODIFY COLUMN `sourceText` MEDIUMTEXT;
ALTER TABLE `translations` MODIFY COLUMN `outputText` MEDIUMTEXT;
ALTER TABLE `translations` MODIFY COLUMN `diagnosticsJson` MEDIUMTEXT;
ALTER TABLE `translations` MODIFY COLUMN `mappingYaml` MEDIUMTEXT;
ALTER TABLE `translations` MODIFY COLUMN `validationSummary` MEDIUMTEXT;
ALTER TABLE `translations` MODIFY COLUMN `validationConcernsJson` MEDIUMTEXT;
