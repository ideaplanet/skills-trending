CREATE TABLE `skill_readme` (
	`skill_pk` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`content_type` text NOT NULL,
	`fetch_source` text NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`skill_pk`) REFERENCES `skill`(`pk`) ON UPDATE no action ON DELETE no action
);
