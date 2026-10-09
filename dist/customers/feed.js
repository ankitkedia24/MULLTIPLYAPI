import { fetchWithRetry } from "../supabase.js";
const PAGE_SIZE = 1000;
const FEED_COLUMNS = [
    "id",
    "customer_code",
    "customer_name",
    "alias_name",
    "email",
    "gstin",
    "address",
    "city",
    "state",
    "pin_code",
    "country",
    "mobile",
    "last_sale_date",
    "updated_at",
    "changed_at",
    "eligible",
].join(",");
/**
 * Read eligible customers from the ERP's mulltiply_customer_feed view
 * (read-only, service-role, paged 1000). The eligibility rule and the phone
 * pick live in the view; this only pages through it. Rows WITHOUT a mobile
 * are still returned (eligible, but unreachable on WhatsApp) so the run
 * report can list them for the office to fix.
 */
export async function fetchCustomers(cfg, opts = {}, fetchImpl = fetch) {
    const rows = [];
    let offset = 0;
    for (;;) {
        const pageLimit = opts.limit !== undefined ? Math.min(PAGE_SIZE, opts.limit - rows.length) : PAGE_SIZE;
        if (pageLimit <= 0)
            break;
        const params = new URLSearchParams({
            select: FEED_COLUMNS,
            eligible: "eq.true",
            order: "customer_code.asc",
            limit: String(pageLimit),
            offset: String(offset),
        });
        if (opts.since)
            params.set("changed_at", `gte.${opts.since}`);
        if (opts.customerCode)
            params.set("customer_code", `eq.${opts.customerCode}`);
        const url = `${cfg.SUPABASE_URL}/rest/v1/mulltiply_customer_feed?${params.toString()}`;
        const headers = {
            apikey: cfg.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${cfg.SUPABASE_SERVICE_ROLE_KEY}`,
        };
        const res = await fetchWithRetry(url, { headers }, fetchImpl);
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Supabase customer feed HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        const page = (await res.json());
        rows.push(...page);
        if (page.length < pageLimit)
            break;
        offset += page.length;
    }
    return rows;
}
//# sourceMappingURL=feed.js.map