-- Server-side deployments (deployments spec §2.7): a new Deployments module.
-- The built-in roles get it at their level — Owner and Admin manage, Operator
-- operate, Viewer view — both in role_defaults (new orgs, "Reset to default")
-- and on every org's existing built-in roles, edited or not, since none could
-- have set a module that did not exist. Custom roles, and the "(modules
-- only)" roles 0025 generated, stay without it until someone turns it on.
-- Nothing else: apps, releases, configs and secrets live on the servers, never
-- in this database (spec §2.6).
UPDATE `role_defaults` SET `module_permissions` = json_set(`module_permissions`, '$.deployments',
	CASE `system` WHEN 'viewer' THEN 'view' WHEN 'operator' THEN 'operate' ELSE 'manage' END)
WHERE `system` IN ('owner', 'admin', 'operator', 'viewer');
--> statement-breakpoint
UPDATE `roles` SET `module_permissions` = json_set(coalesce(`module_permissions`, '{}'), '$.deployments',
	CASE `system` WHEN 'viewer' THEN 'view' WHEN 'operator' THEN 'operate' ELSE 'manage' END)
WHERE `system` IN ('owner', 'admin', 'operator', 'viewer')
	AND json_extract(coalesce(`module_permissions`, '{}'), '$.deployments') IS NULL;
