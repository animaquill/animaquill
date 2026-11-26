ALTER TABLE "lfs_objects" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "lfs_uploads" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "lfs_objects" ADD CONSTRAINT "lfs_objects_provider" CHECK ("lfs_objects"."provider" in ('github', 'local'));--> statement-breakpoint
ALTER TABLE "lfs_uploads" ADD CONSTRAINT "lfs_uploads_provider" CHECK ("lfs_uploads"."provider" in ('github', 'local'));--> statement-breakpoint
ALTER TABLE "lfs_objects" DROP CONSTRAINT "lfs_objects_repo_id_oid_pk";--> statement-breakpoint
ALTER TABLE "lfs_objects" ADD CONSTRAINT "lfs_objects_provider_repo_id_oid_pk" PRIMARY KEY("provider","repo_id","oid");--> statement-breakpoint
DROP INDEX "lfs_uploads_open";--> statement-breakpoint
CREATE UNIQUE INDEX "lfs_uploads_open" ON "lfs_uploads" USING btree ("provider","repo_id","oid") WHERE state in ('receiving', 'received', 'pushing');
