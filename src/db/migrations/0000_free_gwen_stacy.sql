CREATE TABLE `skill` (
	`pk` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`skill_id` text NOT NULL,
	`name` text NOT NULL,
	`is_official` integer,
	`installs_all_time` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skill_view` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`skill_pk` text NOT NULL,
	`view` text NOT NULL,
	`view_date` text NOT NULL,
	`rank` integer NOT NULL,
	`installs` integer NOT NULL,
	`installs_yesterday` integer,
	`change` integer,
	`weekly_installs` text,
	`captured_at` integer NOT NULL,
	`first_captured_at` integer NOT NULL,
	`update_count` integer DEFAULT 1 NOT NULL,
	`is_latest` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`skill_pk`) REFERENCES `skill`(`pk`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_skill_view_slot` ON `skill_view` (`view`,`view_date`,`skill_pk`);--> statement-breakpoint
CREATE INDEX `idx_skill_view_latest` ON `skill_view` (`view`,`is_latest`,`rank`);--> statement-breakpoint
CREATE INDEX `idx_skill_view_skill` ON `skill_view` (`skill_pk`,`view`,`captured_at`);