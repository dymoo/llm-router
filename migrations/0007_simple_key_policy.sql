-- Key policy becomes { priority, cloud, requestsPerMinute, maxConcurrent }.
-- cloud = (overloadAction = 'failover'); every other legacy field is dropped.
-- Rows already in the new shape (a `cloud` field) are left alone.
UPDATE `api_keys` SET `policy_json` = json_object(
  'priority', json_extract(`policy_json`, '$.priority'),
  'cloud', json(CASE WHEN json_extract(`policy_json`, '$.overloadAction') = 'failover' THEN 'true' ELSE 'false' END),
  'requestsPerMinute', json_extract(`policy_json`, '$.requestsPerMinute'),
  'maxConcurrent', json_extract(`policy_json`, '$.maxConcurrent')
) WHERE json_valid(`policy_json`) AND json_type(`policy_json`, '$.cloud') IS NULL;
-- Batch jobs remember whether their key allowed cloud; existing jobs keep spilling.
ALTER TABLE `batch_jobs` ADD `cloud` integer DEFAULT 1 NOT NULL;
