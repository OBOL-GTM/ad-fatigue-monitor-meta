"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ScatterChart, Scatter, CartesianGrid, Cell, Legend, LineChart, Line } from "recharts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import FatigueScoreBadge from "@/components/FatigueScoreBadge";
import RecommendationsPanel from "@/components/RecommendationsPanel";
import type { FatigueStage } from "@/lib/fatigue/types";
import type { Recommendation } from "@/lib/strategy/recommendations";
import type { WoWData } from "@/lib/wow";

interface AdSummary {
  id: string;
  adName: string;
  campaignName: string;
  status: string;
  fatigueScore: number;
  stage: FatigueStage;
  totalSpend: number;
  totalReach: number;
  totalImpressions: number;
  totalClicks: number;
  avgCTR: number;
  avgCPM: number;
  avgFrequency: number;
  avgCPC: number;
  costPerResult: number;
}

interface DailyAdSpend {
  date: string;
  [adName: string]: string | number;
}

interface CampaignSpend {
  campaignName: string;
  spend: number;
  reach: number;
  clicks: number;
  ads: number;
  avgFatigue: number;
}

interface StrategyClientProps {
  ads: AdSummary[];
  dailySpendByAd: DailyAdSpend[];
  campaignSpend: CampaignSpend[];
  accountHealth: number;
  totalSpend: number;
  totalReach: number;
  totalClicks: number;
  totalImpressions: number;
  totalATM: number;
  totalSQLs: number;
  costPerDemo: number | null;
  costPerSQL: number | null;
  demoToSQLRate: number | null;
  clickToLeadRate: number | null;
  dayOfWeek: Array<{ day: string; spend: number; clicks: number; ctr: number }>;
  campaignCPL: Array<{ campaignName: string; spend: number; leads: number; cpl: number | null; matchedUtm: string | null; revenue: number; dealsWon: number; roas: number | null }>;
  unmatchedUtm: Array<{ campaign: string; count: number }>;
  totalRevenue: number;
  wonCount: number;
  totalROAS: number | null;
  unmatchedRevenue: Array<{ campaign: string; revenue: number; deals: number }>;
  unmatchedRevenueTotal: number;
  recommendations: Recommendation[];
  rangeLabel: string;
  wow?: WoWData;
}

const COLORS = ["#6B93D8", "#D06AB8", "#F04E80", "#22c55e", "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#f97316", "#14b8a6"];

function getScoreColor(score: number): string {
  if (score >= 70) return "#ea384c";
  if (score >= 50) return "#f97316";
  if (score >= 30) return "#f59e0b";
  return "#22c55e";
}

function formatCurrency(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function formatNum(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(0);
}

type Tab = "overview" | "efficiency" | "spend";

export default function StrategyClient({
  ads, dailySpendByAd, campaignSpend, accountHealth,
  totalSpend, totalReach, totalClicks, totalImpressions,
  totalATM, totalSQLs, costPerDemo, costPerSQL, demoToSQLRate, clickToLeadRate,
  dayOfWeek, campaignCPL, unmatchedUtm,
  totalRevenue, wonCount, totalROAS, unmatchedRevenue, unmatchedRevenueTotal,
  recommendations, rangeLabel, wow,
}: StrategyClientProps) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("overview");

  const healthColor = accountHealth >= 75 ? "#22c55e" : accountHealth >= 50 ? "#f59e0b" : accountHealth >= 25 ? "#f97316" : "#ea384c";

  // Sort ads by spend for the bar chart
  const spendRanking = [...ads].sort((a, b) => b.totalSpend - a.totalSpend).slice(0, 15);
  const efficiencyRanking = [...ads].filter(a => a.totalClicks > 0).sort((a, b) => a.avgCPC - b.avgCPC);

  // Scatter: spend vs CTR
  const scatterData = ads.filter(a => a.totalSpend > 0).map(a => ({
    name: a.adName.length > 25 ? a.adName.slice(0, 25) + "..." : a.adName,
    spend: a.totalSpend,
    ctr: a.avgCTR,
    score: a.fatigueScore,
    id: a.id,
  }));

  // Campaign-level bar chart
  const campaignData = [...campaignSpend].sort((a, b) => b.spend - a.spend);

  // Get top ad names for the daily spend chart (max 6)
  const topAdNames = spendRanking.slice(0, 6).map(a => a.adName);

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "spend", label: "Spend Breakdown" },
    { key: "efficiency", label: "Efficiency" },
  ];

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {/* Header */}
      <div className="mb-6 animate-fade-in">
        <div className="display-label mb-1.5">Analytics</div>
        <h1 className="display-heading mb-1.5">
          <span className="gradient-text">Performance</span>
        </h1>
        <p className="text-[13.5px] text-gray-600">
          Performance data across your active ads
        </p>
      </div>

      {/* Top Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <div className="lv-card p-4 text-center">
          <div className="text-2xl font-bold">{ads.length}</div>
          <div className="text-[12px] text-gray-500 mt-1">Active Ads</div>
        </div>
        <div className="lv-card p-4 text-center">
          <div className="text-2xl font-bold">{formatCurrency(totalSpend)}</div>
          <div className="text-[12px] text-gray-500 mt-1">Total Spend</div>
        </div>
        <div className="lv-card p-4 text-center">
          <div className="text-2xl font-bold">{formatNum(totalReach)}</div>
          <div className="text-[12px] text-gray-500 mt-1">Total Reach</div>
        </div>
        <div className="lv-card p-4 text-center">
          <div className="text-2xl font-bold">{formatNum(totalClicks)}</div>
          <div className="text-[12px] text-gray-500 mt-1">Total Clicks</div>
        </div>
        <div className="lv-card p-4 text-center">
          <div className="text-2xl font-bold" style={{ color: healthColor }}>{accountHealth}</div>
          <div className="text-[12px] text-gray-500 mt-1">Account Health</div>
        </div>
      </div>

      {/* FUNNEL: Spend → Clicks → Demos → SQLs (Meta × HubSpot) */}
      <div className="lv-card p-6 mb-6 bg-gradient-to-br from-[#6B93D8]/5 via-[#9B7ED0]/5 to-[#D06AB8]/5">
        <div className="mb-4">
          <h2 className="text-[15px] font-semibold text-foreground">Funnel, {rangeLabel}</h2>
          <p className="text-[12px] text-muted-foreground">Ad spend through to qualified deals.</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <div className="rounded-xl bg-white/70 p-4 text-center">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Spend</div>
            <div className="text-[22px] font-bold text-foreground tabular-nums">{formatCurrency(totalSpend)}</div>
          </div>
          <div className="rounded-xl bg-white/70 p-4 text-center">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Clicks</div>
            <div className="text-[22px] font-bold text-foreground tabular-nums">{formatNum(totalClicks)}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              CTR {totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : "0"}%
            </div>
          </div>
          <div className="rounded-xl bg-white/70 p-4 text-center">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Demos Booked</div>
            <div className="text-[22px] font-bold text-[#9B7ED0] tabular-nums">{totalATM}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {clickToLeadRate !== null ? `${clickToLeadRate.toFixed(2)}% of clicks` : "-"}
            </div>
          </div>
          <div className="rounded-xl bg-white/70 p-4 text-center">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">SQLs</div>
            <div className="text-[22px] font-bold text-[#D06AB8] tabular-nums">{totalSQLs}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {demoToSQLRate !== null ? `${demoToSQLRate.toFixed(1)}% of demos` : "-"}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl bg-gradient-to-r from-[#6B93D8]/10 to-[#9B7ED0]/10 p-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Cost per Lead</div>
            <div className="text-[24px] font-bold text-foreground tabular-nums">
              {costPerDemo !== null ? formatCurrency(costPerDemo) : "-"}
            </div>
          </div>
          <div className="rounded-xl bg-gradient-to-r from-[#9B7ED0]/10 to-[#D06AB8]/10 p-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Cost per SQL</div>
            <div className="text-[24px] font-bold text-foreground tabular-nums">
              {costPerSQL !== null ? formatCurrency(costPerSQL) : "-"}
            </div>
          </div>
        </div>
      </div>

      {/* WEEK-OVER-WEEK */}
      {wow && (
        <div className="lv-card p-6 mb-6">
          <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
            <div>
              <h2 className="text-[15px] font-semibold text-foreground">Week over week</h2>
              <p className="text-[12px] text-muted-foreground">
                {wow.thisWeekLabel} vs {wow.lastWeekLabel}. Rolling 7-day window, anchored on today (independent of the range above).
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3 mb-6">
            {[
              { label: "Spend", value: formatCurrency(wow.thisWeek.spend), delta: wow.deltas.spend, color: "#6B93D8" },
              { label: "Inbounds", value: wow.thisWeek.atm.toLocaleString(), delta: wow.deltas.atm, color: "#D06AB8" },
              { label: "MQLs", value: wow.thisWeek.mqls.toLocaleString(), delta: wow.deltas.mqls, color: "#8b5cf6" },
              { label: "SQLs", value: wow.thisWeek.sqls.toLocaleString(), delta: wow.deltas.sqls, color: "#06b6d4" },
              { label: "CPL", value: wow.thisWeek.cpl != null ? formatCurrency(wow.thisWeek.cpl) : "-", delta: wow.deltas.cpl, color: "#F04E80", invertDelta: true },
              { label: "Cost per MQL", value: wow.thisWeek.cpmql != null ? formatCurrency(wow.thisWeek.cpmql) : "-", delta: wow.deltas.cpmql, color: "#06b6d4", invertDelta: true },
              { label: "Cost per SQL", value: wow.thisWeek.costPerSql != null ? formatCurrency(wow.thisWeek.costPerSql) : "-", delta: wow.deltas.costPerSql, color: "#9B7ED0", invertDelta: true },
            ].map(c => {
              const isNeutral = c.delta == null || Math.abs(c.delta) < 0.5;
              const isPositive = c.delta != null && (c.invertDelta ? c.delta < 0 : c.delta > 0);
              const deltaColor = isNeutral ? "text-gray-400" : isPositive ? "text-green-600" : "text-red-600";
              const arrow = c.delta == null ? "" : isNeutral ? "→" : c.delta > 0 ? "↑" : "↓";
              return (
                <div key={c.label} className="rounded-xl bg-white p-3 border border-border">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{c.label}</div>
                  <div className="text-[22px] font-bold tabular-nums mt-1" style={{ color: c.color }}>{c.value}</div>
                  <div className={`text-[12px] font-medium ${deltaColor} mt-0.5`}>
                    {c.delta == null ? "no data last week" : `${arrow} ${Math.abs(c.delta).toFixed(1)}% WoW`}
                  </div>
                </div>
              );
            })}
          </div>
          {wow.weekly.length > 0 && (
            <div>
              <div className="text-[13px] font-semibold text-foreground mb-1">Last 8 weeks</div>
              <div className="text-[11px] text-muted-foreground mb-3">Spend, inbounds, SQLs and CPL by rolling 7-day week.</div>
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer>
                  <LineChart data={wow.weekly} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6b7280" }} axisLine={false} tickLine={false} />
                    <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#6b7280" }} axisLine={false} tickLine={false} width={50} tickFormatter={(v) => formatCurrency(Number(v))} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#6b7280" }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip
                      contentStyle={{ background: "white", border: "1px solid #e5e7eb", borderRadius: "8px", fontSize: "12px" }}
                      formatter={(value: any, name: string) => {
                        if (value === null || value === undefined) return ["-", name];
                        if (name === "Spend" || name === "CPL") return [formatCurrency(Number(value)), name];
                        return [Number(value).toLocaleString(), name];
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: "12px" }} />
                    <Line yAxisId="left" type="monotone" dataKey="spend" name="Spend" stroke="#6B93D8" strokeWidth={2} dot={{ r: 3 }} />
                    <Line yAxisId="right" type="monotone" dataKey="atm" name="Inbounds" stroke="#D06AB8" strokeWidth={2} dot={{ r: 3 }} />
                    <Line yAxisId="right" type="monotone" dataKey="mqls" name="MQLs" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} />
                    <Line yAxisId="right" type="monotone" dataKey="sqls" name="SQLs" stroke="#06b6d4" strokeWidth={2} dot={{ r: 3 }} />
                    <Line yAxisId="left" type="monotone" dataKey="cpl" name="CPL" stroke="#F04E80" strokeWidth={2.5} strokeDasharray="4 2" dot={{ r: 2.5, fill: "#F04E80" }} connectNulls />
                    <Line yAxisId="left" type="monotone" dataKey="cpmql" name="Cost per MQL" stroke="#06b6d4" strokeWidth={2} strokeDasharray="4 2" dot={{ r: 2.5, fill: "#06b6d4" }} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}

      {/* DAY-OF-WEEK */}
      <div className="lv-card p-6 mb-6">
        <div className="mb-4">
          <h2 className="text-[15px] font-semibold text-foreground">Day-of-week performance</h2>
          <p className="text-[12px] text-muted-foreground">Spend + CTR by weekday, spot your best + worst days.</p>
        </div>
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <BarChart data={dayOfWeek} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 12, fill: "#6b7280" }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#6b7280" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${Math.round(v)}`} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#6b7280" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
              <Tooltip
                contentStyle={{ background: "white", border: "1px solid #e5e7eb", borderRadius: "8px", fontSize: "12px" }}
                formatter={(value: any, name: any) => name === "Spend" ? [formatCurrency(Number(value)), "Spend"] : [`${Number(value).toFixed(2)}%`, "CTR"]}
              />
              <Legend wrapperStyle={{ fontSize: "12px" }} />
              <Bar yAxisId="left" dataKey="spend" name="Spend" fill="#6B93D8" radius={[6, 6, 0, 0]} />
              <Bar yAxisId="right" dataKey="ctr" name="CTR" fill="#D06AB8" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex items-center gap-1 glass rounded-xl p-1 mb-8 w-fit">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`cursor-pointer px-4 py-2 rounded-lg text-[13px] font-medium ${
              tab === t.key
                ? "bg-gradient-to-r from-[#6B93D8] via-[#D06AB8] to-[#F04E80] text-white shadow-sm"
                : "text-gray-600 hover:text-black hover:bg-gray-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW TAB ── */}
      {tab === "overview" && (
        <div className="space-y-8">
          {/* Spend vs CTR Scatter */}
          <div className="lv-card p-6">
            <h2 className="text-[16px] font-semibold mb-1">Spend vs CTR</h2>
            <p className="text-[12px] text-gray-500 mb-4">Each dot is an ad. Higher right = spending more. Higher up = better CTR.</p>
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" dataKey="spend" name="Spend" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                  <YAxis type="number" dataKey="ctr" name="CTR" unit="%" tick={{ fontSize: 11 }} />
                  <Tooltip
                    content={({ payload }) => {
                      if (!payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-3 text-[12px]">
                          <div className="font-semibold mb-1">{d.name}</div>
                          <div>Spend: ${d.spend.toFixed(2)}</div>
                          <div>CTR: {d.ctr.toFixed(2)}%</div>
                          <div>Fatigue: {d.score}</div>
                        </div>
                      );
                    }}
                  />
                  <Scatter data={scatterData} fill="#6B93D8">
                    {scatterData.map((entry, i) => (
                      <Cell key={i} fill={getScoreColor(entry.score)} />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Campaign Spend Breakdown */}
          <div className="lv-card p-6">
            <h2 className="text-[16px] font-semibold mb-1">Spend by Campaign</h2>
            <p className="text-[12px] text-gray-500 mb-4">Where your budget is going</p>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={campaignData} layout="vertical" margin={{ top: 0, right: 20, bottom: 0, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                  <YAxis
                    type="category"
                    dataKey="campaignName"
                    width={160}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => v.length > 25 ? v.slice(0, 25) + "..." : v}
                  />
                  <Tooltip
                    content={({ payload }) => {
                      if (!payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-3 text-[12px]">
                          <div className="font-semibold mb-1">{d.campaignName}</div>
                          <div>Spend: ${d.spend.toFixed(2)}</div>
                          <div>Reach: {formatNum(d.reach)}</div>
                          <div>Clicks: {formatNum(d.clicks)}</div>
                          <div>{d.ads} ads &middot; Avg fatigue: {d.avgFatigue}</div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="spend" radius={[0, 6, 6, 0]}>
                    {campaignData.map((entry, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Strategic recommendations, always at the top of Analytics so
              Orly sees the most impactful actions first. */}
          {recommendations.length > 0 && (
            <RecommendationsPanel
              recommendations={recommendations}
              rangeLabel={rangeLabel}
            />
          )}

          {/* Top-line Revenue + ROAS card */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="lv-card p-5">
              <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Revenue (closed-won)</div>
              <div className="text-2xl font-semibold text-foreground tabular-nums">
                ${totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
              <div className="text-[11px] text-gray-500 mt-1">{wonCount} deal{wonCount === 1 ? "" : "s"} in {rangeLabel}</div>
            </div>
            <div className="lv-card p-5">
              <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Meta spend</div>
              <div className="text-2xl font-semibold text-foreground tabular-nums">
                ${totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
              <div className="text-[11px] text-gray-500 mt-1">{rangeLabel}</div>
            </div>
            <div className="lv-card p-5 bg-gradient-to-br from-emerald-50 to-emerald-100/50">
              <div className="text-[11px] uppercase tracking-wide text-emerald-700 mb-1">ROAS</div>
              <div className="text-2xl font-semibold tabular-nums" style={{ color: totalROAS !== null && totalROAS >= 1 ? "#059669" : "#dc2626" }}>
                {totalROAS !== null ? `${totalROAS.toFixed(2)}×` : "-"}
              </div>
              <div className="text-[11px] text-emerald-700/70 mt-1">
                ${totalROAS !== null ? totalROAS.toFixed(2) : "0"} revenue per $1 spent
              </div>
            </div>
          </div>

          {/* Per-Campaign CPL + ROAS, Meta spend × HubSpot ATM leads + won revenue */}
          <div className="lv-card p-6">
            <h2 className="text-[16px] font-semibold mb-1">Cost per Lead & ROAS by Campaign</h2>
            <p className="text-[12px] text-gray-500 mb-4">
              Spend ÷ ATM leads matched via utm_campaign. Revenue is closed-won deal value joined via the same utm match.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-[11px] uppercase tracking-wide text-gray-500">
                    <th className="py-2 pr-4 font-medium">Campaign</th>
                    <th className="py-2 pr-4 font-medium text-right">Spend</th>
                    <th className="py-2 pr-4 font-medium text-right">ATM Leads</th>
                    <th className="py-2 pr-4 font-medium text-right">Cost / Demo</th>
                    <th className="py-2 pr-4 font-medium text-right">Revenue</th>
                    <th className="py-2 pr-4 font-medium text-right">ROAS</th>
                    <th className="py-2 pr-4 font-medium">Matched UTM</th>
                  </tr>
                </thead>
                <tbody>
                  {[...campaignCPL].sort((a, b) => {
                    // Sort: rows with ROAS desc, then rows with CPL asc, then spend desc
                    if (a.roas !== null && b.roas !== null) return b.roas - a.roas;
                    if (a.roas !== null) return -1;
                    if (b.roas !== null) return 1;
                    if (a.cpl !== null && b.cpl !== null) return a.cpl - b.cpl;
                    if (a.cpl !== null) return -1;
                    if (b.cpl !== null) return 1;
                    return b.spend - a.spend;
                  }).map((row) => (
                    <tr key={row.campaignName} className="border-b border-gray-100 last:border-0">
                      <td className="py-2 pr-4 font-medium text-foreground">
                        {row.campaignName.length > 40
                          ? row.campaignName.slice(0, 40) + "…"
                          : row.campaignName}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        ${row.spend.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.leads > 0 ? row.leads : <span className="text-gray-400">-</span>}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums font-semibold">
                        {row.cpl !== null
                          ? `$${row.cpl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                          : <span className="text-gray-400 font-normal">-</span>}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.revenue > 0
                          ? `$${row.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                          : <span className="text-gray-400">-</span>}
                        {row.dealsWon > 0 && (
                          <span className="text-[10px] text-gray-400 ml-1">({row.dealsWon})</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums font-semibold">
                        {row.roas !== null ? (
                          <span style={{ color: row.roas >= 1 ? "#059669" : "#dc2626" }}>
                            {row.roas.toFixed(2)}×
                          </span>
                        ) : <span className="text-gray-400 font-normal">-</span>}
                      </td>
                      <td className="py-2 pr-4 text-[11px] text-gray-500 truncate max-w-[200px]">
                        {row.matchedUtm || <span className="text-gray-300">-</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {unmatchedUtm.length > 0 && (
              <details className="mt-4 text-[12px]">
                <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
                  {unmatchedUtm.reduce((s, u) => s + u.count, 0)} leads from utm_campaigns we couldn't match to a Meta campaign
                </summary>
                <div className="mt-2 space-y-1 pl-4">
                  {unmatchedUtm.map((u) => (
                    <div key={u.campaign} className="flex justify-between text-gray-600">
                      <span className="font-mono text-[11px]">{u.campaign}</span>
                      <span>{u.count} leads</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
            {unmatchedRevenue.length > 0 && (
              <details className="mt-2 text-[12px]">
                <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
                  ${unmatchedRevenueTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })} of closed-won revenue couldn't be matched to a Meta campaign
                </summary>
                <div className="mt-2 space-y-1 pl-4">
                  {unmatchedRevenue.map((r) => (
                    <div key={r.campaign} className="flex justify-between text-gray-600">
                      <span className="font-mono text-[11px]">{r.campaign}</span>
                      <span>${r.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} · {r.deals} deal{r.deals === 1 ? "" : "s"}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>

          {/* Daily Spend Trend (top ads) */}
          {dailySpendByAd.length > 0 && (
            <div className="lv-card p-6">
              <h2 className="text-[16px] font-semibold mb-1">Daily Spend, Top Ads</h2>
              <p className="text-[12px] text-gray-500 mb-4">Last 30 days spend per ad</p>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={dailySpendByAd} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v) => {
                        const d = new Date(v + "T00:00:00");
                        return `${d.getMonth() + 1}/${d.getDate()}`;
                      }}
                    />
                    <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                    <Tooltip
                      labelFormatter={(v) => {
                        const d = new Date(v + "T00:00:00");
                        return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                      }}
                      formatter={(value: number, name: string) => [`$${value.toFixed(2)}`, name.length > 30 ? name.slice(0, 30) + "..." : name]}
                    />
                    {topAdNames.map((name, i) => (
                      <Line
                        key={name}
                        type="monotone"
                        dataKey={name}
                        stroke={COLORS[i % COLORS.length]}
                        strokeWidth={2}
                        dot={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-wrap gap-3 mt-3">
                {topAdNames.map((name, i) => (
                  <div key={name} className="flex items-center gap-1.5 text-[11px] text-gray-600">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                    {name.length > 35 ? name.slice(0, 35) + "..." : name}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── SPEND BREAKDOWN TAB ── */}
      {tab === "spend" && (
        <div className="space-y-6">
          {/* Spend Ranking */}
          <div className="lv-card p-6">
            <h2 className="text-[16px] font-semibold mb-4">Spend Ranking, All Active Ads</h2>
            <div className="space-y-2">
              {spendRanking.map((ad, i) => {
                const pct = spendRanking[0].totalSpend > 0 ? (ad.totalSpend / spendRanking[0].totalSpend) * 100 : 0;
                return (
                  <div onClick={() => router.push(`/ad/${ad.id}`)} key={ad.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 group cursor-pointer">
                    <span className="text-[12px] text-gray-400 w-5 text-right">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[13px] font-medium truncate">{ad.adName}</span>
                        <span className="text-[11px] text-gray-400 truncate">{ad.campaignName}</span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${pct}%`, backgroundColor: getScoreColor(ad.fatigueScore) }}
                        />
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[14px] font-semibold">${ad.totalSpend.toFixed(2)}</div>
                      <div className="text-[11px] text-gray-400">{formatNum(ad.totalImpressions)} imp</div>
                    </div>
                    <FatigueScoreBadge score={ad.fatigueScore} stage={ad.stage} size="sm" showLabel={false} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Spend vs Reach per ad */}
          <div className="lv-card p-6">
            <h2 className="text-[16px] font-semibold mb-1">Spend vs Reach</h2>
            <p className="text-[12px] text-gray-500 mb-4">Are you paying more to reach fewer people?</p>
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" dataKey="spend" name="Spend" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                  <YAxis type="number" dataKey="reach" name="Reach" tickFormatter={(v) => formatNum(v)} tick={{ fontSize: 11 }} />
                  <Tooltip
                    content={({ payload }) => {
                      if (!payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-3 text-[12px]">
                          <div className="font-semibold mb-1">{d.name}</div>
                          <div>Spend: ${d.spend.toFixed(2)}</div>
                          <div>Reach: {formatNum(d.reach)}</div>
                          <div>Cost per 1k reach: ${d.reach > 0 ? ((d.spend / d.reach) * 1000).toFixed(2) : "N/A"}</div>
                        </div>
                      );
                    }}
                  />
                  <Scatter
                    data={ads.filter(a => a.totalSpend > 0).map(a => ({
                      name: a.adName.length > 25 ? a.adName.slice(0, 25) + "..." : a.adName,
                      spend: a.totalSpend,
                      reach: a.totalReach,
                      score: a.fatigueScore,
                    }))}
                    fill="#6B93D8"
                  >
                    {ads.filter(a => a.totalSpend > 0).map((a, i) => (
                      <Cell key={i} fill={getScoreColor(a.fatigueScore)} />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* ── EFFICIENCY TAB ── */}
      {tab === "efficiency" && (
        <div className="space-y-6">
          {/* Best CPC */}
          <div className="lv-card p-6">
            <h2 className="text-[16px] font-semibold mb-1">Best Cost Per Click</h2>
            <p className="text-[12px] text-gray-500 mb-4">Ads getting you the cheapest clicks</p>
            <div className="space-y-2">
              {efficiencyRanking.slice(0, 10).map((ad, i) => (
                <div onClick={() => router.push(`/ad/${ad.id}`)} key={ad.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 cursor-pointer">
                  <span className="text-[12px] text-gray-400 w-5 text-right">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate">{ad.adName}</div>
                    <div className="text-[11px] text-gray-400 truncate">{ad.campaignName}</div>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="text-right">
                      <div className="text-[14px] font-semibold" style={{ color: "#22c55e" }}>${ad.avgCPC.toFixed(2)}</div>
                      <div className="text-[11px] text-gray-400">CPC</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[13px]">{ad.avgCTR.toFixed(2)}%</div>
                      <div className="text-[11px] text-gray-400">CTR</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[13px]">${ad.totalSpend.toFixed(2)}</div>
                      <div className="text-[11px] text-gray-400">Spend</div>
                    </div>
                    <FatigueScoreBadge score={ad.fatigueScore} stage={ad.stage} size="sm" showLabel={false} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Worst CPC */}
          <div className="lv-card p-6">
            <h2 className="text-[16px] font-semibold mb-1">Worst Cost Per Click</h2>
            <p className="text-[12px] text-gray-500 mb-4">Ads burning budget on expensive clicks</p>
            <div className="space-y-2">
              {efficiencyRanking.slice(-Math.min(10, efficiencyRanking.length)).reverse().map((ad, i) => (
                <div onClick={() => router.push(`/ad/${ad.id}`)} key={ad.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 cursor-pointer">
                  <span className="text-[12px] text-gray-400 w-5 text-right">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate">{ad.adName}</div>
                    <div className="text-[11px] text-gray-400 truncate">{ad.campaignName}</div>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="text-right">
                      <div className="text-[14px] font-semibold" style={{ color: "#ea384c" }}>${ad.avgCPC.toFixed(2)}</div>
                      <div className="text-[11px] text-gray-400">CPC</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[13px]">{ad.avgCTR.toFixed(2)}%</div>
                      <div className="text-[11px] text-gray-400">CTR</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[13px]">${ad.totalSpend.toFixed(2)}</div>
                      <div className="text-[11px] text-gray-400">Spend</div>
                    </div>
                    <FatigueScoreBadge score={ad.fatigueScore} stage={ad.stage} size="sm" showLabel={false} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* CPM Comparison */}
          <div className="lv-card p-6">
            <h2 className="text-[16px] font-semibold mb-1">CPM Comparison</h2>
            <p className="text-[12px] text-gray-500 mb-4">Cost per 1,000 impressions across ads</p>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={[...ads].sort((a, b) => b.avgCPM - a.avgCPM).slice(0, 12).map(a => ({
                    name: a.adName.length > 20 ? a.adName.slice(0, 20) + "..." : a.adName,
                    cpm: Math.round(a.avgCPM * 100) / 100,
                    score: a.fatigueScore,
                  }))}
                  layout="vertical"
                  margin={{ top: 0, right: 20, bottom: 0, left: 10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(value: number) => [`$${value.toFixed(2)}`, "CPM"]} />
                  <Bar dataKey="cpm" radius={[0, 6, 6, 0]}>
                    {[...ads].sort((a, b) => b.avgCPM - a.avgCPM).slice(0, 12).map((a, i) => (
                      <Cell key={i} fill={getScoreColor(a.fatigueScore)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
