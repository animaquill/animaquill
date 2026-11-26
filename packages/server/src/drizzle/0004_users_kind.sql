ALTER TABLE "users" ALTER COLUMN "github_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_local" ON "users" USING btree ("kind") WHERE "users"."kind" = 'local';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind" CHECK ("users"."kind" in ('github', 'local'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind_github_id" CHECK (("users"."kind" = 'github') = ("users"."github_id" is not null));