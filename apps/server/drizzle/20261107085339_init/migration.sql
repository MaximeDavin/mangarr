CREATE TABLE `downloads` (
	`id` integer PRIMARY KEY,
	`series_id` integer NOT NULL,
	`info_hash` text NOT NULL UNIQUE,
	`release_title` text NOT NULL,
	`indexer_name` text NOT NULL,
	`prowlarr_guid` text NOT NULL,
	`size` integer NOT NULL,
	`expected_volumes` text DEFAULT '[]' NOT NULL,
	`title_match` text NOT NULL,
	`status` text DEFAULT 'downloading' NOT NULL,
	`status_message` text,
	`grabbed_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`completed_at` integer,
	`imported_at` integer,
	CONSTRAINT `fk_downloads_series_id_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON DELETE CASCADE,
	CONSTRAINT "downloads_title_match_check" CHECK("title_match" IN ('exact', 'partial', 'none')),
	CONSTRAINT "downloads_status_check" CHECK("status" IN ('downloading', 'importing', 'imported', 'needs_attention', 'missing_from_client'))
);
--> statement-breakpoint
CREATE TABLE `import_log_entries` (
	`id` integer PRIMARY KEY,
	`download_id` integer NOT NULL,
	`source_file` text NOT NULL,
	`action` text NOT NULL,
	`volume_number` real,
	`dest_path` text,
	`message` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	CONSTRAINT `fk_import_log_entries_download_id_downloads_id_fk` FOREIGN KEY (`download_id`) REFERENCES `downloads`(`id`) ON DELETE CASCADE,
	CONSTRAINT "import_log_entries_action_check" CHECK("action" IN ('imported', 'skipped_owned', 'skipped_unparseable', 'skipped_format', 'error'))
);
--> statement-breakpoint
CREATE TABLE `languages` (
	`id` integer PRIMARY KEY,
	`code` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`prowlarr_indexer_ids` text DEFAULT '[]' NOT NULL,
	`prowlarr_categories` text DEFAULT '[]' NOT NULL,
	`root_folder` text NOT NULL,
	`komga_library_id` text,
	`use_manga_news_dataset` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_terms` (
	`id` integer PRIMARY KEY,
	`series_id` integer NOT NULL,
	`term` text NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `fk_search_terms_series_id_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON DELETE CASCADE,
	CONSTRAINT `search_terms_series_id_term_unique` UNIQUE(`series_id`,`term`),
	CONSTRAINT "search_terms_kind_check" CHECK("kind" IN ('search', 'alias'))
);
--> statement-breakpoint
CREATE TABLE `series` (
	`id` integer PRIMARY KEY,
	`language_id` integer NOT NULL,
	`mangabaka_id` integer NOT NULL,
	`external_ids` text DEFAULT '{}' NOT NULL,
	`display_title` text NOT NULL,
	`folder_path` text NOT NULL UNIQUE,
	`cover_url` text,
	`status` text,
	`publisher` text,
	`authors` text DEFAULT '[]' NOT NULL,
	`volume_count` integer,
	`volume_count_source` text,
	`metadata_json` text,
	`metadata_fetched_at` integer,
	`last_scanned_at` integer,
	CONSTRAINT `fk_series_language_id_languages_id_fk` FOREIGN KEY (`language_id`) REFERENCES `languages`(`id`),
	CONSTRAINT `series_language_id_mangabaka_id_unique` UNIQUE(`language_id`,`mangabaka_id`),
	CONSTRAINT "series_volume_count_source_check" CHECK("volume_count_source" IN ('mangabaka', 'manganews', 'manual'))
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `volumes` (
	`id` integer PRIMARY KEY,
	`series_id` integer NOT NULL,
	`number` real NOT NULL,
	`file_path` text NOT NULL UNIQUE,
	`file_size` integer NOT NULL,
	`format` text NOT NULL,
	`source` text NOT NULL,
	CONSTRAINT `fk_volumes_series_id_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON DELETE CASCADE,
	CONSTRAINT `volumes_series_id_number_unique` UNIQUE(`series_id`,`number`),
	CONSTRAINT "volumes_format_check" CHECK("format" IN ('cbz', 'cbr')),
	CONSTRAINT "volumes_source_check" CHECK("source" IN ('scan', 'import'))
);
--> statement-breakpoint
CREATE INDEX `downloads_series_id_idx` ON `downloads` (`series_id`);--> statement-breakpoint
CREATE INDEX `import_log_entries_download_id_idx` ON `import_log_entries` (`download_id`);