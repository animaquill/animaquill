ALTER TABLE "project_repos" DROP CONSTRAINT "project_repos_repo_id_unique";--> statement-breakpoint
ALTER TABLE "project_repos" ALTER COLUMN "installation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "archives" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_repos" ADD COLUMN "local_dir" text;--> statement-breakpoint
ALTER TABLE "repo_merges" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_provider_repo" UNIQUE("provider","repo_id");--> statement-breakpoint
ALTER TABLE "archives" ADD CONSTRAINT "archives_provider" CHECK ("archives"."provider" in ('github', 'local'));--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_provider" CHECK ("project_repos"."provider" in ('github', 'local'));--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_installation" CHECK (("project_repos"."provider" = 'github') = ("project_repos"."installation_id" is not null));--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_local_dir" CHECK (("project_repos"."provider" = 'local') = ("project_repos"."local_dir" is not null));--> statement-breakpoint
ALTER TABLE "repo_merges" ADD CONSTRAINT "repo_merges_provider" CHECK ("repo_merges"."provider" in ('github', 'local'));