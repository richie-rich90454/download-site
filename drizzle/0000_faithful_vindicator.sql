CREATE TABLE `asset_cache` (
	`app` text NOT NULL,
	`version` text NOT NULL,
	`asset_name` text NOT NULL,
	`file_path` text NOT NULL,
	`size` integer NOT NULL,
	`checksum` text NOT NULL,
	`last_accessed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`size_on_disk` integer DEFAULT 0 NOT NULL,
	`mtime_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`app`, `version`, `asset_name`)
);
--> statement-breakpoint
CREATE INDEX `idx_asset_cache_access` ON `asset_cache` (`last_accessed_at`);--> statement-breakpoint
CREATE INDEX `idx_asset_cache_created` ON `asset_cache` (`created_at`);--> statement-breakpoint
CREATE TABLE `app_state` (
	`app` text PRIMARY KEY NOT NULL,
	`latest_tag` text,
	`latest_beta_tag` text,
	`list_etag` text,
	`updated_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `releases` (
	`app` text NOT NULL,
	`tag` text NOT NULL,
	`data` blob NOT NULL,
	`etag` text,
	`published_at` integer DEFAULT 0 NOT NULL,
	`prerelease` integer DEFAULT false NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`app`, `tag`)
);
--> statement-breakpoint
CREATE INDEX `idx_releases_expires` ON `releases` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_releases_latest` ON `releases` (`app`,`published_at`);