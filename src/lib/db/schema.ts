import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(), // Meta ad account ID
  name: text("name").notNull(),
  accessToken: text("access_token").notNull(),
  tokenExpiresAt: integer("token_expires_at").notNull(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});

export const ads = sqliteTable("ads", {
  id: text("id").primaryKey(), // Meta ad ID
  accountId: text("account_id").notNull(),
  campaignId: text("campaign_id").notNull(),
  campaignName: text("campaign_name").notNull(),
  adsetId: text("adset_id").notNull(),
  adsetName: text("adset_name").notNull(),
  adName: text("ad_name").notNull(),
  status: text("status").notNull(), // ACTIVE, PAUSED, etc.
  createdAt: integer("created_at"),
  firstSeenAt: integer("first_seen_at").notNull().$defaultFn(() => Date.now()),
  lastSyncedAt: integer("last_synced_at"),
  thumbnailUrl: text("thumbnail_url"),
  imageUrl: text("image_url"), // higher-res image
  adBody: text("ad_body"), // ad primary text / caption
  adHeadline: text("ad_headline"), // headline
  adLinkUrl: text("ad_link_url"), // destination URL
});

export const dailyMetrics = sqliteTable(
  "daily_metrics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    adId: text("ad_id").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD
    impressions: integer("impressions").notNull().default(0),
    reach: integer("reach").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    spend: real("spend").notNull().default(0),
    frequency: real("frequency").notNull().default(0),
    ctr: real("ctr").notNull().default(0),
    cpm: real("cpm").notNull().default(0),
    cpc: real("cpc").notNull().default(0),
    actions: integer("actions").notNull().default(0),
    costPerAction: real("cost_per_action").notNull().default(0),
    conversionRate: real("conversion_rate").notNull().default(0),
    inlinePostEngagement: integer("inline_post_engagement").notNull().default(0),
    postReactions: integer("post_reactions").notNull().default(0),
    postComments: integer("post_comments").notNull().default(0),
    postShares: integer("post_shares").notNull().default(0),
  },
  (table) => ({
    adDateIdx: uniqueIndex("daily_metrics_ad_date_idx").on(table.adId, table.date),
    adDateDescIdx: index("daily_metrics_ad_date_desc_idx").on(table.adId, table.date),
    dateIdx: index("daily_metrics_date_idx").on(table.date),
  })
);

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  adId: text("ad_id").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  fatigueScore: real("fatigue_score").notNull(),
  stage: text("stage").notNull(), // healthy, early_warning, fatiguing, fatigued
  signals: text("signals").notNull(), // JSON string
  dismissed: integer("dismissed").notNull().default(0),
});

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey().default(1),
  sensitivityPreset: text("sensitivity_preset").notNull().default("medium"),
  ctrWeight: real("ctr_weight").notNull().default(0.20),
  cpmWeight: real("cpm_weight").notNull().default(0.15),
  frequencyWeight: real("frequency_weight").notNull().default(0.25),
  conversionWeight: real("conversion_weight").notNull().default(0.20),
  costPerResultWeight: real("cost_per_result_weight").notNull().default(0.10),
  engagementWeight: real("engagement_weight").notNull().default(0.10),
  baselineWindowDays: integer("baseline_window_days").notNull().default(7),
  recentWindowDays: integer("recent_window_days").notNull().default(3),
  minDataDays: integer("min_data_days").notNull().default(5),
});

export const hubspotConfig = sqliteTable("hubspot_config", {
  id: integer("id").primaryKey().default(1),
  apiKey: text("api_key").notNull().default(""),
  atmProperty: text("atm_property").notNull().default("agreed_to_meet_date___test_"),
  sqlClassification: text("sql_classification").notNull().default("hs_lead_status_sql"), // comma-separated
  mqlDefinition: text("mql_definition").notNull().default("form_fill"),
  updatedAt: integer("updated_at").$defaultFn(() => Date.now()),
});

export const teamInvites = sqliteTable("team_invites", {
  email: text("email").primaryKey(),
  invitedAt: integer("invited_at").notNull().$defaultFn(() => Date.now()),
  invitedBy: text("invited_by"),
  lastSeenAt: integer("last_seen_at"),
});

export const shareTokens = sqliteTable("share_tokens", {
  token: text("token").primaryKey(),
  label: text("label"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  createdBy: text("created_by"),
  expiresAt: integer("expires_at"),
  revokedAt: integer("revoked_at"),
  usesCount: integer("uses_count").notNull().default(0),
});

// Anonymous public view-only links, no login required.
export const publicLinks = sqliteTable("public_links", {
  token: text("token").primaryKey(),
  label: text("label"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  createdBy: text("created_by"),
  revokedAt: integer("revoked_at"),
  viewsCount: integer("views_count").notNull().default(0),
});

// Type exports
export type Account = typeof accounts.$inferSelect;
export type Ad = typeof ads.$inferSelect;
export type DailyMetric = typeof dailyMetrics.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type HubSpotConfig = typeof hubspotConfig.$inferSelect;
export type TeamInvite = typeof teamInvites.$inferSelect;
export type ShareToken = typeof shareTokens.$inferSelect;
export type PublicLink = typeof publicLinks.$inferSelect;
