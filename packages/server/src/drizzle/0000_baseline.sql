CREATE TABLE "archives" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" text NOT NULL,
	"repo_id" bigint NOT NULL,
	"seq" bigint NOT NULL,
	"sha" text NOT NULL,
	"parent_sha" text,
	"kind" text NOT NULL,
	"name" text,
	"changed" integer NOT NULL,
	"removed" integer NOT NULL,
	"kept" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"by_user" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deleted_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_tokens" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"access_token" "bytea" NOT NULL,
	"access_expires_at" timestamp with time zone,
	"refresh_token" "bytea",
	"refresh_expires_at" timestamp with time zone,
	"generation" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" bigint PRIMARY KEY NOT NULL,
	"account_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lfs_objects" (
	"repo_id" bigint NOT NULL,
	"oid" text NOT NULL,
	"size" bigint NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lfs_objects_repo_id_oid_pk" PRIMARY KEY("repo_id","oid")
);
--> statement-breakpoint
CREATE TABLE "lfs_uploads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"repo_id" bigint NOT NULL,
	"oid" text NOT NULL,
	"size" bigint NOT NULL,
	"received" bigint DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"error" text,
	"detail" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lfs_uploads_state" CHECK ("lfs_uploads"."state" in ('receiving', 'received', 'pushing', 'done', 'failed', 'expired')),
	CONSTRAINT "lfs_uploads_received" CHECK ("lfs_uploads"."received" >= 0 and "lfs_uploads"."received" <= "lfs_uploads"."size")
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"state_hash" "bytea" PRIMARY KEY NOT NULL,
	"verifier" "bytea" NOT NULL,
	"return_to" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"undoes" text,
	"merge_id" uuid,
	"seq" bigint NOT NULL,
	"label" text NOT NULL,
	"files" integer NOT NULL,
	"writes" "bytea" NOT NULL,
	"undo" jsonb,
	"format_version" integer NOT NULL,
	"snapshot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_covers" (
	"project_id" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"type" text NOT NULL,
	"etag" text NOT NULL,
	"duration_ms" integer,
	"chosen" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_covers_type" CHECK ("project_covers"."type" in ('image/webp', 'image/jpeg')),
	CONSTRAINT "project_covers_bytes" CHECK (octet_length("project_covers"."bytes") <= 65536),
	CONSTRAINT "project_covers_duration" CHECK ("project_covers"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_groups" (
	"owner_id" uuid NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_groups_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "project_groups_id" CHECK ("project_groups"."id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "project_groups_name_length" CHECK (char_length("project_groups"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "project_marks" (
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"starred" boolean,
	"star_at" timestamp with time zone,
	"group_id" text,
	"group_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_marks_user_id_project_id_pk" PRIMARY KEY("user_id","project_id"),
	CONSTRAINT "project_marks_star" CHECK (("project_marks"."starred" is null) = ("project_marks"."star_at" is null)),
	CONSTRAINT "project_marks_group_at" CHECK ("project_marks"."group_id" is null or "project_marks"."group_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "project_repos" (
	"project_id" text PRIMARY KEY NOT NULL,
	"installation_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"owner_id" bigint NOT NULL,
	"owner_login" text NOT NULL,
	"name" text NOT NULL,
	"branch" text NOT NULL,
	"private" boolean NOT NULL,
	"created_here" boolean NOT NULL,
	"linked_by" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"pause_reason" text,
	"detail" text,
	"paused_at" timestamp with time zone,
	"paused_seq" bigint,
	"requested_at" timestamp with time zone,
	"requested_by" uuid,
	"diverged" jsonb,
	"head_sha" text,
	"replaced_sha" text,
	"pending_sha" text,
	"pending" jsonb,
	"archived_seq" bigint DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lfs_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"checked_at" timestamp with time zone,
	"gone_cause" text,
	"unusable_since" timestamp with time zone,
	"unusable_seen_at" timestamp with time zone,
	"recheck_at" timestamp with time zone,
	"rechecks" integer DEFAULT 0 NOT NULL,
	"rechecked_at" timestamp with time zone,
	"transient_since" timestamp with time zone,
	"prefer" text DEFAULT 'editor' NOT NULL,
	"merged_sha" text,
	"blocked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"merge_from" text,
	"dropping" jsonb,
	"dropping_merge" uuid,
	"merge_floor" bigint,
	CONSTRAINT "project_repos_repo_id_unique" UNIQUE("repo_id"),
	CONSTRAINT "project_repos_state" CHECK ("project_repos"."state" in ('ready', 'paused')),
	CONSTRAINT "project_repos_gone_cause" CHECK ("project_repos"."gone_cause" in ('deleted', 'removed')),
	CONSTRAINT "project_repos_prefer" CHECK ("project_repos"."prefer" in ('editor', 'github'))
);
--> statement-breakpoint
CREATE TABLE "project_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"digest" text NOT NULL,
	"state" "bytea" NOT NULL,
	"reason" text NOT NULL,
	"device" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_updates" (
	"project_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"digest" text NOT NULL,
	"data" "bytea" NOT NULL,
	"kind" text NOT NULL,
	"device" text NOT NULL,
	"window" text NOT NULL,
	"base" bigint NOT NULL,
	"behind" boolean DEFAULT false NOT NULL,
	"made_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"batch" text,
	CONSTRAINT "project_updates_project_id_seq_pk" PRIMARY KEY("project_id","seq")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"head" bigint DEFAULT 0 NOT NULL,
	"digest" text DEFAULT '' NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dirty_since" timestamp with time zone,
	"copy_state" text DEFAULT 'live' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"opened_at" timestamp with time zone,
	"stats" jsonb,
	"released_at" timestamp with time zone,
	"released_from" jsonb,
	"copy_problem" jsonb,
	"rebuild_attempts" integer DEFAULT 0 NOT NULL,
	"rebuild_started_at" timestamp with time zone,
	"rebuild_from_branch" boolean DEFAULT false NOT NULL,
	"linking_until" timestamp with time zone,
	CONSTRAINT "projects_head" CHECK ("projects"."head" >= 0),
	CONSTRAINT "projects_copy_state" CHECK ("projects"."copy_state" in ('live', 'released', 'restoring')),
	CONSTRAINT "projects_generation" CHECK ("projects"."generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE "repo_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" text NOT NULL,
	"merge_id" uuid,
	"batch" text NOT NULL,
	"source" text NOT NULL,
	"lost" text NOT NULL,
	"file" text NOT NULL,
	"path" jsonb NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"lines" jsonb,
	"around" jsonb,
	"ours" jsonb,
	"theirs" jsonb,
	"ours_by" text,
	"ours_at" timestamp with time zone,
	"theirs_sha" text,
	"theirs_at" timestamp with time zone,
	"change" "bytea",
	"state" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_conflicts_state" CHECK ("repo_conflicts"."state" in ('open', 'ours', 'theirs', 'stale')),
	CONSTRAINT "repo_conflicts_lost" CHECK ("repo_conflicts"."lost" in ('batch', 'change'))
);
--> statement-breakpoint
CREATE TABLE "repo_merges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" text NOT NULL,
	"repo_id" bigint NOT NULL,
	"from_sha" text NOT NULL,
	"to_sha" text NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"input" "bytea",
	"seq" bigint,
	"ours_seq" bigint,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "repo_merges_state" CHECK ("repo_merges"."state" in ('ready', 'applied', 'superseded', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" "bytea" PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signups" (
	"id_hash" "bytea" PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"login" text NOT NULL,
	"avatar_url" text,
	"access_token" "bytea" NOT NULL,
	"access_expires_at" timestamp with time zone,
	"refresh_token" "bytea",
	"refresh_expires_at" timestamp with time zone,
	"return_to" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_ai_keys" (
	"user_id" uuid NOT NULL,
	"service" text NOT NULL,
	"sealed" "bytea",
	"format" smallint DEFAULT 1 NOT NULL,
	"fields_at" jsonb,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_ai_keys_user_id_service_pk" PRIMARY KEY("user_id","service"),
	CONSTRAINT "user_ai_keys_service" CHECK ("user_ai_keys"."service" ~ '^[A-Za-z0-9_-]{1,100}$'),
	CONSTRAINT "user_ai_keys_format" CHECK ("user_ai_keys"."format" in (1, 2))
);
--> statement-breakpoint
CREATE TABLE "user_ai_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"format" integer DEFAULT 1 NOT NULL,
	"entries" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_ai_settings_size" CHECK ("user_ai_settings"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_chat_image_refs" (
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "user_chat_image_refs_user_id_project_id_chat_id_hash_pk" PRIMARY KEY("user_id","project_id","chat_id","hash")
);
--> statement-breakpoint
CREATE TABLE "user_chat_images" (
	"user_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"bytes" integer NOT NULL,
	"type" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"touched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_chat_images_user_id_hash_pk" PRIMARY KEY("user_id","hash"),
	CONSTRAINT "user_chat_images_hash" CHECK ("user_chat_images"."hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "user_chat_images_bytes" CHECK ("user_chat_images"."bytes" > 0),
	CONSTRAINT "user_chat_images_state" CHECK ("user_chat_images"."state" in ('uploading', 'ready'))
);
--> statement-breakpoint
CREATE TABLE "user_chats" (
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"revision" integer NOT NULL,
	"summary" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"size" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_chats_user_id_project_id_chat_id_pk" PRIMARY KEY("user_id","project_id","chat_id"),
	CONSTRAINT "user_chats_id" CHECK ("user_chats"."chat_id" ~ '^[A-Za-z0-9_-]{1,100}$')
);
--> statement-breakpoint
CREATE TABLE "user_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"organizer_sync" boolean DEFAULT true NOT NULL,
	"organizer_epoch" integer DEFAULT 0 NOT NULL,
	"chats_sync" boolean DEFAULT true NOT NULL,
	"chats_epoch" integer DEFAULT 0 NOT NULL,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lfs_acknowledged_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"github_id" bigint NOT NULL,
	"login" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archives" ADD CONSTRAINT "archives_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archives" ADD CONSTRAINT "archives_by_user_users_id_fk" FOREIGN KEY ("by_user") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_projects" ADD CONSTRAINT "deleted_projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD CONSTRAINT "github_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lfs_uploads" ADD CONSTRAINT "lfs_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lfs_uploads" ADD CONSTRAINT "lfs_uploads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_batches" ADD CONSTRAINT "project_batches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_batches" ADD CONSTRAINT "project_batches_merge_id_repo_merges_id_fk" FOREIGN KEY ("merge_id") REFERENCES "public"."repo_merges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_covers" ADD CONSTRAINT "project_covers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_groups" ADD CONSTRAINT "project_groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_marks" ADD CONSTRAINT "project_marks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_marks" ADD CONSTRAINT "project_marks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_marks" ADD CONSTRAINT "project_marks_group_fk" FOREIGN KEY ("user_id","group_id") REFERENCES "public"."project_groups"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_snapshots" ADD CONSTRAINT "project_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_updates" ADD CONSTRAINT "project_updates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_conflicts" ADD CONSTRAINT "repo_conflicts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_conflicts" ADD CONSTRAINT "repo_conflicts_merge_id_repo_merges_id_fk" FOREIGN KEY ("merge_id") REFERENCES "public"."repo_merges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_conflicts" ADD CONSTRAINT "repo_conflicts_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_merges" ADD CONSTRAINT "repo_merges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_keys" ADD CONSTRAINT "user_ai_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chat_image_refs" ADD CONSTRAINT "user_chat_image_refs_chat_fk" FOREIGN KEY ("user_id","project_id","chat_id") REFERENCES "public"."user_chats"("user_id","project_id","chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chat_image_refs" ADD CONSTRAINT "user_chat_image_refs_image_fk" FOREIGN KEY ("user_id","hash") REFERENCES "public"."user_chat_images"("user_id","hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chat_images" ADD CONSTRAINT "user_chat_images_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chats" ADD CONSTRAINT "user_chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chats" ADD CONSTRAINT "user_chats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD CONSTRAINT "user_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archives_project" ON "archives" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "deleted_projects_owner" ON "deleted_projects" USING btree ("owner_id","deleted_at");--> statement-breakpoint
CREATE INDEX "installations_account" ON "installations" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lfs_uploads_open" ON "lfs_uploads" USING btree ("repo_id","oid") WHERE state in ('receiving', 'received', 'pushing');--> statement-breakpoint
CREATE INDEX "lfs_uploads_user" ON "lfs_uploads" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "lfs_uploads_state" ON "lfs_uploads" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "lfs_uploads_project" ON "lfs_uploads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "login_attempts_expires" ON "login_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "project_batches_project" ON "project_batches" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_batches_undoes" ON "project_batches" USING btree ("undoes");--> statement-breakpoint
CREATE UNIQUE INDEX "project_groups_name" ON "project_groups" USING btree ("owner_id","name_key") WHERE not "project_groups"."deleted";--> statement-breakpoint
CREATE INDEX "project_marks_group" ON "project_marks" USING btree ("user_id","group_id");--> statement-breakpoint
CREATE INDEX "project_snapshots_project" ON "project_snapshots" USING btree ("project_id","reason","seq");--> statement-breakpoint
CREATE INDEX "projects_owner" ON "projects" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "repo_conflicts_open" ON "repo_conflicts" USING btree ("project_id") WHERE "repo_conflicts"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "repo_merges_ready" ON "repo_merges" USING btree ("project_id") WHERE "repo_merges"."state" = 'ready';--> statement-breakpoint
CREATE INDEX "repo_merges_project" ON "repo_merges" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "signups_expires" ON "signups" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_chat_image_refs_image" ON "user_chat_image_refs" USING btree ("user_id","hash");--> statement-breakpoint
CREATE INDEX "user_chat_images_touched" ON "user_chat_images" USING btree ("touched_at");--> statement-breakpoint
CREATE INDEX "user_chats_project" ON "user_chats" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received" ON "webhook_deliveries" USING btree ("received_at");