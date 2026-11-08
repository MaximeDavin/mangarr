CREATE TABLE `manga_news_series` (
	`id` integer PRIMARY KEY,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`search_title` text NOT NULL,
	`publisher` text,
	`volume_count` integer NOT NULL,
	`artists` text,
	`writers` text,
	`genres` text DEFAULT '[]' NOT NULL,
	`cover_url` text,
	`dataset_imported_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `series` ADD `manga_news_series_id` integer REFERENCES manga_news_series(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `series_manga_news_series_id_idx` ON `series` (`manga_news_series_id`);