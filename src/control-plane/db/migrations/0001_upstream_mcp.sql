CREATE TABLE `upstream_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`args` text,
	`env` text,
	`cwd` text,
	`url` text,
	`auth_type` text,
	`auth_secret` text,
	`headers` text,
	`read_roots` text,
	`write_roots` text,
	`timeout_ms` integer DEFAULT 30000 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'down' NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_upstream_servers_updated_at` ON `upstream_servers` (`updated_at`);--> statement-breakpoint
CREATE TABLE `upstream_tools` (
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`exposed_name` text NOT NULL,
	`description` text,
	`input_schema` text,
	`annotations` text,
	`exposed` integer DEFAULT true NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`server_id`, `name`)
);
--> statement-breakpoint
CREATE INDEX `idx_upstream_tools_server_id` ON `upstream_tools` (`server_id`);--> statement-breakpoint
CREATE INDEX `idx_upstream_tools_exposed_name` ON `upstream_tools` (`exposed_name`);