CREATE TABLE "bookmark_tags" (
	"bookmark_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	CONSTRAINT "bookmark_tags_bookmark_id_tag_id_pk" PRIMARY KEY("bookmark_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'unread' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookmark_tags" ADD CONSTRAINT "bookmark_tags_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "public"."bookmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmark_tags" ADD CONSTRAINT "bookmark_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookmarks_status_idx" ON "bookmarks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_name_uq" ON "tags" USING btree ("name");