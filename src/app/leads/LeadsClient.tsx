"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import DateRangePicker from "@/components/DateRangePicker";
import QuickPresets from "@/components/QuickPresets";
import type { WoWData } from "@/lib/wow";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  Cell, LineChart, Line, Legend, AreaChart, Area, ScatterChart, Scatter, ZAxis,
  PieChart, Pie,
} from "recharts";

const COLORS = ["#6B93D8", "#D06AB8", "#F04E80", "#22c55e", "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899"];

interface DailyData { date: string; spend: number; clicks: number; impressions: number }
interface CampaignData { campaignName: string; spend: number; clicks: number; impressions: number; reach: number; cpc: number }
interface LeadContact { id: string; name: string; email: string; company: string; stage: string; date: string; type: string; source?: string; sourcePlatform?: string; campaign?: string; adset?: string; ad?: string }

interface DailyCPL { date: string; spend: number; atm: number; sqls: number; cpl: number | null; costPerSql: number | null }

interface Props {
  totalSpend: number;
  totalClicks: number;
  totalImpressions: number;
  totalConversions: number;
  totalReach: number;
  dailyData: DailyData[];
  campaignBreakdown: CampaignData[];
  rangeFrom: string;
  rangeTo: string;
  activeAdCount: number;
  hubspotATM?: { date: string; atm: number; sqls: number }[];
  hubspotMQLs?: { date: string; mqls: number }[];
  totalATM?: number;
  totalSQLs?: number;
  totalMQLs?: number;
  campaignNames: string[];
  dailyByCampaign: Record<string, any>[];
  leadContacts?: LeadContact[];
  dailyCPL?: DailyCPL[];
  wow?: WoWData;
  costPerMQL?: number | null;
  mqlYesShare?: number | null;
  totalInbounds?: number;
}

function formatNum(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(0);
}

function shortName(name: string, max = 20): string {
  return name.length > max ? name.slice(0, max) + "..." : name;
}

export default function LeadsClient({
  totalSpend, totalClicks, totalImpressions, totalConversions, totalReach,
  dailyData, campaignBreakdown, rangeFrom, rangeTo, activeAdCount,
  hubspotATM, hubspotMQLs, totalATM, totalSQLs, totalMQLs,
  campaignNames, dailyByCampaign, leadContacts, dailyCPL, wow,
  costPerMQL, mqlYesShare, totalInbounds,
}: Props) {
  const router = useRouter();
  const [from, setFrom] = useState(rangeFrom);
  const [to, setTo] = useState(rangeTo);
  const [drillDown, setDrillDown] = useState<"atm" | "sql" | null>(null);
  const [isPending, startTransition] = useTransition();
  const [dateChanged, setDateChanged] = useState(false);

  // Auto-apply dates after debounce
  useEffect(() => {
    if (!dateChanged || !from || !to) return;
    const timer = setTimeout(() => {
      router.push(`/strategy?from=${from}&to=${to}`);
    }, 600);
    return () => clearTimeout(timer);
  }, [from, to, dateChanged, router]);

  const handleApply = () => {
    if (from && to) router.push(`/strategy?from=${from}&to=${to}`);
  };

  const handleRefreshHS = () => {
    startTransition(() => {
      router.refresh();
    });
  };

  const cplATM = totalATM && totalATM > 0 ? totalSpend / totalATM : null;
  const costPerSQL = totalSQLs && totalSQLs > 0 ? totalSpend / totalSQLs : null;
  const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const costPerClick = totalClicks > 0 ? totalSpend / totalClicks : 0;
  const hasHubSpot = (hubspotATM && hubspotATM.length > 0) || (hubspotMQLs && hubspotMQLs.length > 0);

  // Month-to-date "running" CPL day-over-day.
  // Totals RESET at the first of every month so you can compare e.g.
  // March 21 vs April 21 at the same point in the month. Within a month,
  // each day is cumulative spend / cumulative ATMs through that day.
  // Flat on zero-lead days instead of spiking.
  const runningSeries = (dailyCPL ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const mqlsByDate = new Map((hubspotMQLs ?? []).map(d => [d.date, d.mqls]));
  let cumSpend = 0, cumAtm = 0, cumSqls = 0, cumMqls = 0;
  let lastCPL: number | null = null;
  let lastCostPerSQL: number | null = null;
  let lastCPMQL: number | null = null;
  let currentMonth = "";
  const runningData = runningSeries.map((d) => {
    const monthKey = d.date.slice(0, 7); // YYYY-MM
    if (monthKey !== currentMonth) {
      // New month, reset accumulators and the carried-forward CPL line.
      currentMonth = monthKey;
      cumSpend = 0;
      cumAtm = 0;
      cumSqls = 0;
      cumMqls = 0;
      lastCPL = null;
      lastCostPerSQL = null;
      lastCPMQL = null;
    }
    cumSpend += d.spend || 0;
    cumAtm += d.atm || 0;
    cumSqls += d.sqls || 0;
    cumMqls += mqlsByDate.get(d.date) || 0;
    if (cumAtm > 0) lastCPL = Math.round((cumSpend / cumAtm) * 100) / 100;
    if (cumSqls > 0) lastCostPerSQL = Math.round((cumSpend / cumSqls) * 100) / 100;
    if (cumMqls > 0) lastCPMQL = Math.round((cumSpend / cumMqls) * 100) / 100;
    return {
      date: d.date,
      cumSpend: Math.round(cumSpend * 100) / 100,
      cumAtm,
      cumSqls,
      cumMqls,
      cpl: lastCPL,
      costPerSql: lastCostPerSQL,
      cpmql: lastCPMQL,
    };
  });

  // Week-over-week ATM, bucket daily ATM counts into ISO weeks (Mon → Sun)
  const weeklyATM = (() => {
    if (!hubspotATM || hubspotATM.length === 0) return [] as { weekStart: string; atm: number; sqls: number; label: string }[];
    const getMonday = (d: Date) => {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);
      monday.setHours(0, 0, 0, 0);
      return monday;
    };
    const weekMap = new Map<string, { weekStart: string; atm: number; sqls: number }>();
    for (const row of hubspotATM) {
      const d = new Date(row.date + "T00:00:00");
      if (isNaN(d.getTime())) continue;
      const monday = getMonday(d);
      const key = format(monday, "yyyy-MM-dd");
      const entry = weekMap.get(key) || { weekStart: key, atm: 0, sqls: 0 };
      entry.atm += row.atm;
      entry.sqls += row.sqls;
      weekMap.set(key, entry);
    }
    return Array.from(weekMap.values())
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
      .map(w => {
        const start = new Date(w.weekStart + "T00:00:00");
        const end = new Date(start);
        end.setDate(end.getDate() + 6);
        return {
          ...w,
          label: `${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}`,
        };
      });
  })();

  // Drill-down filtered contacts
  const drillContacts = leadContacts?.filter(c => {
    if (drillDown === "atm") return c.type === "atm" || c.type === "sql";
    if (drillDown === "sql") return c.type === "sql";
    return false;
  }) || [];

  const pieData = campaignBreakdown.map((c, i) => ({
    name: shortName(c.campaignName),
    value: c.spend,
    fill: COLORS[i % COLORS.length],
  }));

  const scatterData = campaignBreakdown.map((c, i) => ({
    name: c.campaignName, spend: c.spend, reach: c.reach, clicks: c.clicks, cpc: c.cpc,
    fill: COLORS[i % COLORS.length],
  }));

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {/* Header + Date Range */}
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap animate-fade-in">
        <div>
          <div className="display-label mb-1.5">Leads & Analytics</div>
          <h1 className="display-heading mb-1.5">
            <span className="gradient-text">Leads</span>
          </h1>
          <p className="text-[13.5px] text-gray-600">
            Meta ad performance {hasHubSpot ? "& HubSpot leads" : ""}, your source of truth
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <QuickPresets />
          <DateRangePicker />
        </div>
      </div>

      {/* Meta Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        <StatCard label="Ad Spend" value={`$${totalSpend.toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
        <StatCard label="Clicks" value={formatNum(totalClicks)} />
        <StatCard label="Impressions" value={formatNum(totalImpressions)} />
        <StatCard label="CTR" value={`${ctr.toFixed(2)}%`} />
        <StatCard label="CPC" value={`$${costPerClick.toFixed(2)}`} />
      </div>

      {/* HubSpot Funnel */}
      {hasHubSpot ? (
        <>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[16px] font-semibold text-gray-900">Lead Funnel</h2>
            <button onClick={handleRefreshHS} disabled={isPending}
              className="cursor-pointer flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-gray-900 px-2 py-1 rounded-md hover:bg-gray-100 min-h-[32px]">
              <svg className={`w-3.5 h-3.5 ${isPending ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
              </svg>
              <span className="pointer-events-none">Refresh HubSpot</span>
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
            <button onClick={() => setDrillDown(drillDown === "atm" ? null : "atm")}
              className={`cursor-pointer text-left lv-card p-4 transition-all ${drillDown === "atm" ? "ring-2 ring-[#D06AB8]" : "hover:shadow-md"}`}>
              <div className="text-2xl font-bold text-[#D06AB8]">{totalATM ?? 0}</div>
              <div className="text-[12px] text-gray-500 mt-1">Inbound Leads</div>
              <div className="text-[10px] text-gray-400">ATM / Demos Booked</div>
            </button>
            <div className="lv-card p-4">
              <div className="text-2xl font-bold text-[#8b5cf6]">{totalMQLs ?? 0}</div>
              <div className="text-[12px] text-gray-500 mt-1">MQLs</div>
              <div className="text-[10px] text-gray-400">Marketing-qualified</div>
            </div>
            <button onClick={() => setDrillDown(drillDown === "sql" ? null : "sql")}
              className={`cursor-pointer text-left lv-card p-4 transition-all ${drillDown === "sql" ? "ring-2 ring-[#06b6d4]" : "hover:shadow-md"}`}>
              <div className="text-2xl font-bold text-[#06b6d4]">{totalSQLs ?? 0}</div>
              <div className="text-[12px] text-gray-500 mt-1">SQLs</div>
              <div className="text-[10px] text-gray-400">Qualified</div>
            </button>
            <StatCard label="CPL" value={cplATM ? `$${cplATM.toFixed(2)}` : "-"} color="#D06AB8" subtitle="per Inbound Lead" />
            <StatCard label="Cost per MQL" value={costPerMQL ? `$${costPerMQL.toFixed(2)}` : "-"} color="#8b5cf6" />
            <StatCard label="Cost per SQL" value={costPerSQL ? `$${costPerSQL.toFixed(2)}` : "-"} color="#F04E80" />
          </div>

          {/* Drill-down table */}
          {drillDown && drillContacts.length > 0 && (
            <div className="lv-card p-6 mb-8 animate-in slide-in-from-top-2">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[15px] font-semibold text-gray-900">
                  {drillDown === "atm" ? "Inbound Leads (ATM)" : "SQLs"}, {drillContacts.length} contacts
                </h3>
                <button onClick={() => setDrillDown(null)} className="cursor-pointer text-[12px] text-gray-400 hover:text-gray-900 px-2 py-1 rounded-md hover:bg-gray-100 min-h-[32px]">
                  Close
                </button>
              </div>
              <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                <table className="w-full text-[12px]">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-2 px-2 text-gray-500 font-medium">Name</th>
                      <th className="text-left py-2 px-2 text-gray-500 font-medium">Email</th>
                      <th className="text-left py-2 px-2 text-gray-500 font-medium">Company</th>
                      <th className="text-left py-2 px-2 text-gray-500 font-medium">Source</th>
                      <th className="text-left py-2 px-2 text-gray-500 font-medium">Campaign</th>
                      <th className="text-left py-2 px-2 text-gray-500 font-medium">Stage</th>
                      <th className="text-left py-2 px-2 text-gray-500 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillContacts.map((c) => (
                      <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="py-2 px-2 font-medium text-gray-900">{c.name || "-"}</td>
                        <td className="py-2 px-2 text-gray-600">{c.email || "-"}</td>
                        <td className="py-2 px-2 text-gray-600">{c.company || "-"}</td>
                        <td className="py-2 px-2">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${sourceColor(c.source)}`}>
                            {friendlySource(c.source)}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-gray-600 max-w-[180px] truncate" title={c.campaign || "-"}>{c.campaign || "-"}</td>
                        <td className="py-2 px-2">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                            c.type === "sql" ? "bg-cyan-50 text-cyan-700" :
                            c.type === "atm" ? "bg-pink-50 text-pink-700" :
                            "bg-purple-50 text-purple-700"
                          }`}>
                            {c.type === "sql" ? "SQL" : c.type === "atm" ? "ATM" : "MQL"}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-gray-500">{c.date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </>
      ) : (
        <div className="lv-card p-6 mb-8 border-l-4 border-[#8b5cf6]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <svg className="w-6 h-6 text-[#8b5cf6] flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
              </svg>
              <div>
                <p className="text-[14px] font-semibold text-black">Connect HubSpot to see your full funnel</p>
                <p className="text-[13px] text-gray-600 mt-0.5">
                  See MQLs, demos booked (ATM), SQLs, and CPL alongside your Meta spend.
                </p>
              </div>
            </div>
            <button onClick={() => router.push("/connect-hubspot")}
              className="cursor-pointer px-4 py-2 rounded-lg bg-gradient-to-r from-[#6B93D8] via-[#D06AB8] to-[#F04E80] text-white text-[13px] font-medium whitespace-nowrap min-h-[40px]">
              Connect HubSpot
            </button>
          </div>
        </div>
      )}

      {/* Week-over-week, always rolling last 7 days vs prior 7 days */}
      {wow && (
        <div className="lv-card p-6 mb-8 bg-gradient-to-br from-[#6B93D8]/5 via-[#9B7ED0]/5 to-[#D06AB8]/5">
          <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
            <div>
              <h2 className="text-[16px] font-semibold text-gray-900">Week over week</h2>
              <p className="text-[12px] text-gray-500">
                {wow.thisWeekLabel} vs {wow.lastWeekLabel}. Rolling 7-day window, anchored on today.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
            <WoWStatCard label="Ad spend" value={`$${wow.thisWeek.spend.toLocaleString("en-US", { maximumFractionDigits: 0 })}`} delta={wow.deltas.spend} color="#6B93D8" />
            <WoWStatCard label="Inbounds" value={wow.thisWeek.atm.toLocaleString()} delta={wow.deltas.atm} color="#D06AB8" />
            <WoWStatCard label="MQLs" value={wow.thisWeek.mqls.toLocaleString()} delta={wow.deltas.mqls} color="#8b5cf6" />
            <WoWStatCard label="SQLs" value={wow.thisWeek.sqls.toLocaleString()} delta={wow.deltas.sqls} color="#06b6d4" />
            <WoWStatCard label="CPL" value={wow.thisWeek.cpl != null ? `$${wow.thisWeek.cpl.toFixed(2)}` : "-"} delta={wow.deltas.cpl} invertDelta color="#F04E80" />
            <WoWStatCard label="Cost per MQL" value={wow.thisWeek.cpmql != null ? `$${wow.thisWeek.cpmql.toFixed(2)}` : "-"} delta={wow.deltas.cpmql} invertDelta color="#06b6d4" />
            <WoWStatCard label="Cost per SQL" value={wow.thisWeek.costPerSql != null ? `$${wow.thisWeek.costPerSql.toFixed(2)}` : "-"} delta={wow.deltas.costPerSql} invertDelta color="#9B7ED0" />
          </div>

          {/* 8-week weekly trend chart */}
          {wow.weekly.length > 0 && (
            <div className="mt-6">
              <div className="text-[13px] font-semibold text-gray-900 mb-1">Last 8 weeks</div>
              <div className="text-[11px] text-gray-500 mb-3">Spend, inbounds, SQLs and CPL by rolling 7-day week.</div>
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={wow.weekly} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis yAxisId="left" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(value: any, name: string) => {
                        if (value === null || value === undefined) return ["-", name];
                        if (name === "Spend" || name === "CPL") return [`$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`, name];
                        return [Number(value).toLocaleString(), name];
                      }}
                    />
                    <Legend />
                    <Line yAxisId="left" type="monotone" dataKey="spend" stroke="#6B93D8" strokeWidth={2} dot={{ r: 3 }} name="Spend" />
                    <Line yAxisId="right" type="monotone" dataKey="atm" stroke="#D06AB8" strokeWidth={2} dot={{ r: 3 }} name="Inbounds" />
                    <Line yAxisId="right" type="monotone" dataKey="mqls" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} name="MQLs" />
                    <Line yAxisId="right" type="monotone" dataKey="sqls" stroke="#06b6d4" strokeWidth={2} dot={{ r: 3 }} name="SQLs" />
                    <Line yAxisId="left" type="monotone" dataKey="cpl" stroke="#F04E80" strokeWidth={2.5} strokeDasharray="4 2" dot={{ r: 2.5, fill: "#F04E80" }} connectNulls name="CPL" />
                    <Line yAxisId="left" type="monotone" dataKey="cpmql" stroke="#06b6d4" strokeWidth={2} strokeDasharray="4 2" dot={{ r: 2.5, fill: "#06b6d4" }} connectNulls name="Cost per MQL" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}

      {/* MQL yes/no distribution + daily MQLs (mirrors HubSpot inbound dashboard).
          Sits under WoW so the trailing metrics flow together. */}
      {hasHubSpot && (totalInbounds ?? 0) > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <div className="lv-card p-6">
            <h2 className="text-[16px] font-semibold mb-1">MQL distribution</h2>
            <p className="text-[12px] text-gray-500 mb-4">Of inbound companies this period, how many are marketing-qualified.</p>
            <div className="h-[260px] flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[
                      { name: "Yes", value: Math.min(totalMQLs ?? 0, totalInbounds ?? 0), fill: "#8b5cf6" },
                      { name: "No", value: Math.max(0, (totalInbounds ?? 0) - (totalMQLs ?? 0)), fill: "#e5e7eb" },
                    ]}
                    cx="50%" cy="50%" innerRadius={60} outerRadius={100}
                    paddingAngle={2} dataKey="value" nameKey="name"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    labelLine={{ stroke: "#9ca3af", strokeWidth: 1 }}
                  >
                    <Cell fill="#8b5cf6" />
                    <Cell fill="#e5e7eb" />
                  </Pie>
                  <Tooltip formatter={(value: number) => `${value} companies`} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="text-center text-[12px] text-gray-500 mt-2">
              {mqlYesShare != null
                ? `${mqlYesShare.toFixed(1)}% of inbounds (${totalMQLs ?? 0} of ${totalInbounds ?? 0}) reached MQL`
                : "-"}
            </div>
          </div>
          <div className="lv-card p-6">
            <h2 className="text-[16px] font-semibold mb-1">MTD Spend vs MTD MQLs</h2>
            <p className="text-[12px] text-gray-500 mb-4">
              Cumulative ad spend and MQL-qualified companies day by day. Both reset on the 1st so you can compare the same day across months.
            </p>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={runningData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }}
                    tickFormatter={(v) => { const d = new Date(v + "T00:00:00"); return `${d.getMonth() + 1}/${d.getDate()}`; }} />
                  <YAxis yAxisId="spend" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="mqls" orientation="right" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip
                    labelFormatter={(v) => { const d = new Date(v + "T00:00:00"); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }}
                    formatter={(value: any, name: string) => {
                      if (value === null || value === undefined) return ["-", name];
                      if (name === "MTD spend") return [`$${Number(value).toFixed(0)}`, name];
                      if (name === "MTD MQLs") return [`${Number(value)} MQL${Number(value) === 1 ? "" : "s"}`, name];
                      return [value, name];
                    }}
                  />
                  <Legend />
                  <Line yAxisId="spend" type="monotone" dataKey="cumSpend" stroke="#6B93D8" strokeWidth={2} dot={false} name="MTD spend" />
                  <Line yAxisId="mqls" type="monotone" dataKey="cumMqls" stroke="#8b5cf6" strokeWidth={2.5} dot={{ r: 3, fill: "#8b5cf6" }} connectNulls name="MTD MQLs" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Running CPL vs Cumulative Spend */}
      {runningData.length > 0 && hasHubSpot && (
        <div className="lv-card p-6 mb-8">
          <h2 className="text-[16px] font-semibold mb-1">MTD CPL vs MTD Spend</h2>
          <p className="text-[12px] text-gray-500 mb-4">
            Each day's CPL = month-to-date spend ÷ month-to-date ATMs. Both reset at the 1st of every month so you can compare the same day across months.
          </p>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={runningData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }}
                  tickFormatter={(v) => { const d = new Date(v + "T00:00:00"); return `${d.getMonth() + 1}/${d.getDate()}`; }} />
                <YAxis yAxisId="spend" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                <YAxis yAxisId="cpl" orientation="right" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                <Tooltip
                  labelFormatter={(v) => { const d = new Date(v + "T00:00:00"); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }}
                  formatter={(value: any, name: string) => {
                    if (value === null || value === undefined) return ["-", name];
                    if (name === "MTD spend") return [`$${Number(value).toFixed(0)}`, name];
                    if (name === "Running CPL") return [`$${Number(value).toFixed(0)}`, name];
                    return [value, name];
                  }}
                />
                <Legend />
                <Line yAxisId="spend" type="monotone" dataKey="cumSpend" stroke="#6B93D8" strokeWidth={2} dot={false} name="MTD spend" />
                <Line yAxisId="cpl" type="monotone" dataKey="cpl" stroke="#F04E80" strokeWidth={2.5} dot={{ r: 3, fill: "#F04E80" }} connectNulls name="Running CPL" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Running Cost per MQL vs Cumulative Spend */}
      {runningData.length > 0 && hasHubSpot && (
        <div className="lv-card p-6 mb-8">
          <h2 className="text-[16px] font-semibold mb-1">MTD Cost per MQL vs MTD Spend</h2>
          <p className="text-[12px] text-gray-500 mb-4">
            Each day's cost per MQL = month-to-date spend ÷ month-to-date MQLs. Both reset at the 1st of every month.
          </p>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={runningData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }}
                  tickFormatter={(v) => { const d = new Date(v + "T00:00:00"); return `${d.getMonth() + 1}/${d.getDate()}`; }} />
                <YAxis yAxisId="spend" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                <YAxis yAxisId="cpm" orientation="right" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                <Tooltip
                  labelFormatter={(v) => { const d = new Date(v + "T00:00:00"); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }}
                  formatter={(value: any, name: string) => {
                    if (value === null || value === undefined) return ["-", name];
                    if (name === "MTD spend") return [`$${Number(value).toFixed(0)}`, name];
                    if (name === "Running cost per MQL") return [`$${Number(value).toFixed(0)}`, name];
                    return [value, name];
                  }}
                />
                <Legend />
                <Line yAxisId="spend" type="monotone" dataKey="cumSpend" stroke="#6B93D8" strokeWidth={2} dot={false} name="MTD spend" />
                <Line yAxisId="cpm" type="monotone" dataKey="cpmql" stroke="#06b6d4" strokeWidth={2.5} dot={{ r: 3, fill: "#06b6d4" }} connectNulls name="Running cost per MQL" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Running Cost per SQL vs Cumulative Spend */}
      {runningData.length > 0 && hasHubSpot && (
        <div className="lv-card p-6 mb-8">
          <h2 className="text-[16px] font-semibold mb-1">MTD Cost per SQL vs MTD Spend</h2>
          <p className="text-[12px] text-gray-500 mb-4">
            Each day's cost per SQL = month-to-date spend ÷ month-to-date SQLs. Both reset at the 1st of every month.
          </p>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={runningData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }}
                  tickFormatter={(v) => { const d = new Date(v + "T00:00:00"); return `${d.getMonth() + 1}/${d.getDate()}`; }} />
                <YAxis yAxisId="spend" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                <YAxis yAxisId="cps" orientation="right" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                <Tooltip
                  labelFormatter={(v) => { const d = new Date(v + "T00:00:00"); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }}
                  formatter={(value: any, name: string) => {
                    if (value === null || value === undefined) return ["-", name];
                    if (name === "MTD spend") return [`$${Number(value).toFixed(0)}`, name];
                    if (name === "Running cost per SQL") return [`$${Number(value).toFixed(0)}`, name];
                    return [value, name];
                  }}
                />
                <Legend />
                <Line yAxisId="spend" type="monotone" dataKey="cumSpend" stroke="#6B93D8" strokeWidth={2} dot={false} name="MTD spend" />
                <Line yAxisId="cps" type="monotone" dataKey="costPerSql" stroke="#8b5cf6" strokeWidth={2.5} dot={{ r: 3, fill: "#8b5cf6" }} connectNulls name="Running cost per SQL" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* MTD Spend vs MTD Leads (actual ATM count) */}
      {runningData.length > 0 && hasHubSpot && (
        <div className="lv-card p-6 mb-8">
          <h2 className="text-[16px] font-semibold mb-1">MTD Spend vs MTD Leads</h2>
          <p className="text-[12px] text-gray-500 mb-4">
            Cumulative ad spend and the actual leads (ATMs) you generated, day by day. Both reset on the 1st so you can compare the same day across months.
          </p>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={runningData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }}
                  tickFormatter={(v) => { const d = new Date(v + "T00:00:00"); return `${d.getMonth() + 1}/${d.getDate()}`; }} />
                <YAxis yAxisId="spend" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                <YAxis yAxisId="leads" orientation="right" allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip
                  labelFormatter={(v) => { const d = new Date(v + "T00:00:00"); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }}
                  formatter={(value: any, name: string) => {
                    if (value === null || value === undefined) return ["-", name];
                    if (name === "MTD spend") return [`$${Number(value).toFixed(0)}`, name];
                    if (name === "MTD leads") return [`${Number(value)} lead${Number(value) === 1 ? "" : "s"}`, name];
                    return [value, name];
                  }}
                />
                <Legend />
                <Line yAxisId="spend" type="monotone" dataKey="cumSpend" stroke="#6B93D8" strokeWidth={2} dot={false} name="MTD spend" />
                <Line yAxisId="leads" type="monotone" dataKey="cumAtm" stroke="#F04E80" strokeWidth={2.5} dot={{ r: 3, fill: "#F04E80" }} connectNulls name="MTD leads" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Daily Spend vs Clicks */}
      <div className="lv-card p-6 mb-8">
        <h2 className="text-[16px] font-semibold mb-1">Daily Spend vs Clicks</h2>
        <p className="text-[12px] text-gray-500 mb-4">Are you spending more but getting fewer clicks?</p>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={dailyData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }}
                tickFormatter={(v) => { const d = new Date(v + "T00:00:00"); return `${d.getMonth() + 1}/${d.getDate()}`; }} />
              <YAxis yAxisId="spend" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
              <YAxis yAxisId="clicks" orientation="right" tick={{ fontSize: 11 }} />
              <Tooltip
                labelFormatter={(v) => { const d = new Date(v + "T00:00:00"); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }}
                formatter={(value: number, name: string) => {
                  if (name === "Spend") return [`$${value.toFixed(2)}`, "Spend"];
                  return [value.toLocaleString(), name];
                }}
              />
              <Legend />
              <Line yAxisId="spend" type="monotone" dataKey="spend" stroke="#6B93D8" strokeWidth={2} dot={false} name="Spend" />
              <Line yAxisId="clicks" type="monotone" dataKey="clicks" stroke="#D06AB8" strokeWidth={2} dot={false} name="Clicks" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Daily Spend by Campaign, Stacked Area */}
      <div className="lv-card p-6 mb-8">
        <h2 className="text-[16px] font-semibold mb-1">Daily Spend by Campaign</h2>
        <p className="text-[12px] text-gray-500 mb-4">Where is your budget going each day?</p>
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={dailyByCampaign} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }}
                tickFormatter={(v) => { const d = new Date(v + "T00:00:00"); return `${d.getMonth() + 1}/${d.getDate()}`; }} />
              <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
              <Tooltip
                labelFormatter={(v) => { const d = new Date(v + "T00:00:00"); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }}
                formatter={(value: number, name: string) => [`$${value.toFixed(2)}`, name.replace(/_spend$/, "")]}
              />
              <Legend formatter={(value) => shortName(value.replace(/_spend$/, ""), 24)} />
              {campaignNames.map((name, i) => (
                <Area key={name} type="monotone" dataKey={`${name}_spend`} stackId="1"
                  stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.6} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Two-column: Spend vs Reach + Spend Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        <div className="lv-card p-6">
          <h2 className="text-[16px] font-semibold mb-1">Spend vs Reach</h2>
          <p className="text-[12px] text-gray-500 mb-4">Are you getting reach for your money?</p>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" dataKey="spend" name="Spend" tickFormatter={(v) => `$${formatNum(v)}`} tick={{ fontSize: 11 }} />
                <YAxis type="number" dataKey="reach" name="Reach" tickFormatter={(v) => formatNum(v)} tick={{ fontSize: 11 }} />
                <ZAxis type="number" dataKey="clicks" range={[60, 400]} name="Clicks" />
                <Tooltip content={({ payload }) => {
                  if (!payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-3 text-[12px]">
                      <div className="font-semibold mb-1">{shortName(d.name, 30)}</div>
                      <div>Spend: ${d.spend.toLocaleString()}</div>
                      <div>Reach: {formatNum(d.reach)}</div>
                      <div>Clicks: {formatNum(d.clicks)}</div>
                      <div>CPC: ${d.cpc.toFixed(2)}</div>
                    </div>
                  );
                }} />
                {scatterData.map((d) => (
                  <Scatter key={d.name} data={[d]} fill={d.fill} name={shortName(d.name, 20)} />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lv-card p-6">
          <h2 className="text-[16px] font-semibold mb-1">Spend Distribution</h2>
          <p className="text-[12px] text-gray-500 mb-4">How is your budget split across campaigns?</p>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={100}
                  paddingAngle={2} dataKey="value" nameKey="name" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={{ stroke: "#9ca3af", strokeWidth: 1 }}>
                  {pieData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Campaign Spend Ranking */}
      <div className="lv-card p-6 mb-8">
        <h2 className="text-[16px] font-semibold mb-1">Campaign Spend Ranking</h2>
        <p className="text-[12px] text-gray-500 mb-4">Ranked by total spend in this period</p>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={campaignBreakdown} layout="vertical" margin={{ top: 0, right: 20, bottom: 0, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
              <XAxis type="number" tickFormatter={(v) => `$${formatNum(v)}`} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="campaignName" width={160} tick={{ fontSize: 11 }}
                tickFormatter={(v) => shortName(v, 28)} />
              <Tooltip content={({ payload }) => {
                if (!payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-3 text-[12px]">
                    <div className="font-semibold mb-1">{d.campaignName}</div>
                    <div>Spend: ${d.spend.toLocaleString()}</div>
                    <div>Clicks: {formatNum(d.clicks)}</div>
                    <div>CPC: ${d.cpc.toFixed(2)}</div>
                    <div>Reach: {formatNum(d.reach)}</div>
                  </div>
                );
              }} />
              <Bar dataKey="spend" radius={[0, 6, 6, 0]}>
                {campaignBreakdown.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Campaign Data Table */}
      <div className="lv-card p-6 mb-8">
        <h2 className="text-[16px] font-semibold mb-1">Campaign Details</h2>
        <p className="text-[12px] text-gray-500 mb-4">Full breakdown per campaign</p>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-2 px-2 text-gray-500 font-medium">Campaign</th>
                <th className="text-right py-2 px-2 text-gray-500 font-medium">Spend</th>
                <th className="text-right py-2 px-2 text-gray-500 font-medium">Clicks</th>
                <th className="text-right py-2 px-2 text-gray-500 font-medium">CPC</th>
                <th className="text-right py-2 px-2 text-gray-500 font-medium">CTR</th>
                <th className="text-right py-2 px-2 text-gray-500 font-medium">Impressions</th>
                <th className="text-right py-2 px-2 text-gray-500 font-medium">Reach</th>
              </tr>
            </thead>
            <tbody>
              {campaignBreakdown.map((c) => (
                <tr key={c.campaignName} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2.5 px-2 font-medium text-black truncate max-w-[200px]">{c.campaignName}</td>
                  <td className="py-2.5 px-2 text-right">${c.spend.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
                  <td className="py-2.5 px-2 text-right">{formatNum(c.clicks)}</td>
                  <td className="py-2.5 px-2 text-right">${c.cpc.toFixed(2)}</td>
                  <td className="py-2.5 px-2 text-right">{c.impressions > 0 ? ((c.clicks / c.impressions) * 100).toFixed(2) : "0.00"}%</td>
                  <td className="py-2.5 px-2 text-right">{formatNum(c.impressions)}</td>
                  <td className="py-2.5 px-2 text-right">{formatNum(c.reach)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

function StatCard({ label, value, color, subtitle }: { label: string; value: string; color?: string; subtitle?: string }) {
  return (
    <div className="lv-card p-4 text-center">
      <div className="text-2xl font-bold" style={color ? { color } : undefined}>{value}</div>
      <div className="text-[12px] text-gray-500 mt-1">{label}</div>
      {subtitle && <div className="text-[10px] text-gray-400">{subtitle}</div>}
    </div>
  );
}

function WoWStatCard({
  label, value, delta, invertDelta = false, color,
}: { label: string; value: string; delta: number | null; invertDelta?: boolean; color?: string }) {
  const isNeutral = delta == null || Math.abs(delta) < 0.5;
  const isPositive = delta != null && (invertDelta ? delta < 0 : delta > 0);
  const deltaColor = isNeutral ? "text-gray-400" : isPositive ? "text-green-600" : "text-red-600";
  const arrow = delta == null ? "" : isNeutral ? "→" : delta > 0 ? "↑" : "↓";
  return (
    <div className="lv-card p-4">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">{label}</div>
      <div className="text-[24px] font-bold tabular-nums mt-1" style={color ? { color } : undefined}>{value}</div>
      <div className={`text-[12px] font-medium ${deltaColor} mt-0.5`}>
        {delta == null ? "no data last week" : `${arrow} ${Math.abs(delta).toFixed(1)}% WoW`}
      </div>
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  PAID_SOCIAL: "Paid Social",
  ORGANIC_SEARCH: "Organic Search",
  DIRECT_TRAFFIC: "Direct",
  SOCIAL_MEDIA: "Social Media",
  PAID_SEARCH: "Paid Search",
  EMAIL_MARKETING: "Email",
  REFERRALS: "Referral",
  OTHER_CAMPAIGNS: "Other Campaigns",
  OFFLINE: "Offline",
};

function friendlySource(source?: string): string {
  if (!source) return "Untracked";
  return SOURCE_LABELS[source] || source.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

function sourceColor(source?: string): string {
  if (!source) return "bg-gray-100 text-gray-600";
  switch (source) {
    case "PAID_SOCIAL": return "bg-blue-50 text-blue-700";
    case "ORGANIC_SEARCH": return "bg-green-50 text-green-700";
    case "DIRECT_TRAFFIC": return "bg-amber-50 text-amber-700";
    case "SOCIAL_MEDIA": return "bg-indigo-50 text-indigo-700";
    case "PAID_SEARCH": return "bg-violet-50 text-violet-700";
    case "EMAIL_MARKETING": return "bg-rose-50 text-rose-700";
    case "REFERRALS": return "bg-teal-50 text-teal-700";
    default: return "bg-gray-100 text-gray-600";
  }
}

const SOURCE_COLORS: Record<string, string> = {
  "Paid Social": "#6B93D8",
  "Organic Search": "#22c55e",
  "Direct": "#f59e0b",
  "Social Media": "#8b5cf6",
  "Paid Search": "#D06AB8",
  "Email": "#ec4899",
  "Referral": "#06b6d4",
  "Untracked": "#9ca3af",
};

function LeadAttribution({ contacts }: { contacts: LeadContact[] }) {
  const [view, setView] = useState<"source" | "campaign" | "adset" | "ad">("source");

  // Group by source
  const sourceMap = new Map<string, LeadContact[]>();
  for (const c of contacts) {
    const key = friendlySource(c.source);
    if (!sourceMap.has(key)) sourceMap.set(key, []);
    sourceMap.get(key)!.push(c);
  }
  const sourceData = Array.from(sourceMap.entries())
    .map(([name, items]) => ({ name, count: items.length, fill: SOURCE_COLORS[name] || "#9ca3af" }))
    .sort((a, b) => b.count - a.count);

  // Build campaign/adset/ad groupings. Only count paid leads for granular views.
  const groupBy = (key: "campaign" | "adset" | "ad") => {
    const map = new Map<string, { count: number; source: string; campaign?: string; adset?: string; contacts: LeadContact[] }>();
    for (const c of contacts) {
      const raw = (c as any)[key] as string | undefined;
      const source = friendlySource(c.source);
      // For adset/ad views, skip contacts without that level (non-paid or missing UTMs)
      if ((key === "adset" || key === "ad") && (!raw || !raw.trim())) continue;
      const name = raw && raw.trim() ? raw.trim() : "Untracked Inbound";
      if (!map.has(name)) map.set(name, { count: 0, source, campaign: c.campaign, adset: c.adset, contacts: [] });
      const entry = map.get(name)!;
      entry.count++;
      entry.contacts.push(c);
    }
    return Array.from(map.entries())
      .map(([name, data]) => ({ name, count: data.count, source: data.source, campaign: data.campaign, adset: data.adset }))
      .sort((a, b) => b.count - a.count);
  };
  const campaignData = groupBy("campaign");
  const adsetData = groupBy("adset");
  const adData = groupBy("ad");
  const granularData = view === "campaign" ? campaignData : view === "adset" ? adsetData : adData;
  const granularLabel = view === "campaign" ? "Campaign" : view === "adset" ? "Ad Set" : "Ad";

  return (
    <div className="lv-card p-6 mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-[16px] font-semibold text-gray-900">Lead Attribution</h2>
          <p className="text-[12px] text-gray-500">Where are your leads coming from?</p>
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          {(["source", "campaign", "adset", "ad"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`cursor-pointer px-3 py-1.5 rounded-md text-[12px] font-medium transition-all capitalize ${view === v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
              By {v === "source" ? "Source" : v === "campaign" ? "Campaign" : v === "adset" ? "Ad Set" : "Ad"}
            </button>
          ))}
        </div>
      </div>

      {view === "source" ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Source pie chart */}
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={sourceData} cx="50%" cy="50%" innerRadius={50} outerRadius={90}
                  paddingAngle={2} dataKey="count" nameKey="name"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={{ stroke: "#9ca3af", strokeWidth: 1 }}>
                  {sourceData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => [`${value} leads`, "Count"]} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {/* Source table */}
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-2 text-gray-500 font-medium">Source</th>
                  <th className="text-right py-2 px-2 text-gray-500 font-medium">Leads</th>
                  <th className="text-right py-2 px-2 text-gray-500 font-medium">% of Total</th>
                </tr>
              </thead>
              <tbody>
                {sourceData.map((s) => (
                  <tr key={s.name} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2.5 px-2">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.fill }} />
                        <span className="font-medium text-gray-900">{s.name}</span>
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-right font-semibold">{s.count}</td>
                    <td className="py-2.5 px-2 text-right text-gray-500">{((s.count / contacts.length) * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : granularData.length === 0 ? (
        <div className="py-12 text-center text-gray-500 text-[13px]">
          <div className="font-semibold mb-1 text-gray-700">No {granularLabel.toLowerCase()}-level attribution found</div>
          <div>Tag your Meta ads with UTMs (utm_campaign, utm_term, utm_content) so leads can be attributed here.</div>
        </div>
      ) : (
        <div>
          {/* Granular bar chart */}
          <div style={{ height: Math.max(240, granularData.length * 36) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={granularData} layout="vertical" margin={{ top: 0, right: 20, bottom: 0, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={240} tick={{ fontSize: 11 }}
                  tickFormatter={(v) => shortName(v, 38)} />
                <Tooltip content={({ payload }) => {
                  if (!payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-3 text-[12px]">
                      <div className="font-semibold mb-1">{d.name}</div>
                      <div>{d.count} leads</div>
                      <div className="text-gray-500">{d.source}</div>
                      {d.campaign && view !== "campaign" && <div className="text-gray-400 text-[11px] mt-1">Campaign: {d.campaign}</div>}
                      {d.adset && view === "ad" && <div className="text-gray-400 text-[11px]">Ad Set: {d.adset}</div>}
                    </div>
                  );
                }} />
                <Bar dataKey="count" radius={[0, 6, 6, 0]}>
                  {granularData.map((d, i) => (
                    <Cell key={i} fill={d.name === "Untracked Inbound" ? "#9ca3af" : COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* Granular table */}
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-2 text-gray-500 font-medium">{granularLabel}</th>
                  {view !== "campaign" && <th className="text-left py-2 px-2 text-gray-500 font-medium">Campaign</th>}
                  {view === "ad" && <th className="text-left py-2 px-2 text-gray-500 font-medium">Ad Set</th>}
                  <th className="text-left py-2 px-2 text-gray-500 font-medium">Source</th>
                  <th className="text-right py-2 px-2 text-gray-500 font-medium">Leads</th>
                  <th className="text-right py-2 px-2 text-gray-500 font-medium">% of Total</th>
                </tr>
              </thead>
              <tbody>
                {granularData.map((c) => (
                  <tr key={c.name} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2.5 px-2 font-medium text-gray-900 max-w-[260px] truncate" title={c.name}>{c.name}</td>
                    {view !== "campaign" && <td className="py-2.5 px-2 text-gray-600 max-w-[180px] truncate" title={c.campaign || "-"}>{c.campaign || "-"}</td>}
                    {view === "ad" && <td className="py-2.5 px-2 text-gray-600 max-w-[180px] truncate" title={c.adset || "-"}>{c.adset || "-"}</td>}
                    <td className="py-2.5 px-2 text-gray-500">{c.source}</td>
                    <td className="py-2.5 px-2 text-right font-semibold">{c.count}</td>
                    <td className="py-2.5 px-2 text-right text-gray-500">{((c.count / contacts.length) * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
