CREATE TABLE "agent_budgets" (
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"count" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_budgets_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "agent_cards" (
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"window_id" text NOT NULL,
	"card" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_cards_user_id_project_id_agent_id_pk" PRIMARY KEY("user_id","project_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "agent_holds" (
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"window_id" text NOT NULL,
	"holds" boolean NOT NULL,
	"since" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_holds_user_id_project_id_agent_id_window_id_pk" PRIMARY KEY("user_id","project_id","agent_id","window_id")
);
--> statement-breakpoint
CREATE TABLE "agent_mail" (
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"mail_id" text NOT NULL,
	"to_agent" text NOT NULL,
	"from_agent" text NOT NULL,
	"text" text NOT NULL,
	"body" jsonb NOT NULL,
	"left" boolean NOT NULL,
	"sent_at" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_mail_user_id_project_id_mail_id_pk" PRIMARY KEY("user_id","project_id","mail_id"),
	CONSTRAINT "agent_mail_text" CHECK (char_length("agent_mail"."text") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "agent_watches" (
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"target" text NOT NULL,
	"watcher" text NOT NULL,
	"until" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_watches_user_id_project_id_target_watcher_pk" PRIMARY KEY("user_id","project_id","target","watcher")
);
--> statement-breakpoint
CREATE TABLE "agent_windows" (
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"window_id" text NOT NULL,
	"live_until" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_windows_user_id_project_id_window_id_pk" PRIMARY KEY("user_id","project_id","window_id"),
	CONSTRAINT "agent_windows_id" CHECK ("agent_windows"."window_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "agent_budgets" ADD CONSTRAINT "agent_budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budgets" ADD CONSTRAINT "agent_budgets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_holds" ADD CONSTRAINT "agent_holds_window_fk" FOREIGN KEY ("user_id","project_id","window_id") REFERENCES "public"."agent_windows"("user_id","project_id","window_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mail" ADD CONSTRAINT "agent_mail_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mail" ADD CONSTRAINT "agent_mail_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_watches" ADD CONSTRAINT "agent_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_watches" ADD CONSTRAINT "agent_watches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_windows" ADD CONSTRAINT "agent_windows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_windows" ADD CONSTRAINT "agent_windows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_cards_updated" ON "agent_cards" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_holds_one" ON "agent_holds" USING btree ("user_id","project_id","agent_id") WHERE "agent_holds"."holds";--> statement-breakpoint
CREATE INDEX "agent_holds_window" ON "agent_holds" USING btree ("user_id","project_id","window_id");--> statement-breakpoint
CREATE INDEX "agent_mail_to" ON "agent_mail" USING btree ("user_id","project_id","to_agent");--> statement-breakpoint
CREATE INDEX "agent_mail_expires" ON "agent_mail" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_watches_until" ON "agent_watches" USING btree ("until");--> statement-breakpoint
CREATE INDEX "agent_windows_live" ON "agent_windows" USING btree ("live_until");