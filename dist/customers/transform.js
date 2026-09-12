/** Trim and collapse internal whitespace runs to single spaces. */
function clean(value) {
    return (value ?? "").replace(/\s+/g, " ").trim();
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/**
 * Indian states / union territories → the two-letter code Mulltiply expects
 * in provinceCode (their example: "WB"). ERP `state` is free text; matched
 * case-insensitively on the name, or accepted as-is when it already is a
 * code. Unknown → provinceCode "" with a warning; province keeps the text.
 */
const STATE_CODES = {
    "ANDAMAN AND NICOBAR ISLANDS": "AN",
    "ANDHRA PRADESH": "AP",
    "ARUNACHAL PRADESH": "AR",
    ASSAM: "AS",
    BIHAR: "BR",
    CHANDIGARH: "CH",
    CHHATTISGARH: "CG",
    "DADRA AND NAGAR HAVELI AND DAMAN AND DIU": "DH",
    DELHI: "DL",
    "NEW DELHI": "DL",
    GOA: "GA",
    GUJARAT: "GJ",
    HARYANA: "HR",
    "HIMACHAL PRADESH": "HP",
    "JAMMU AND KASHMIR": "JK",
    JHARKHAND: "JH",
    KARNATAKA: "KA",
    KERALA: "KL",
    LADAKH: "LA",
    LAKSHADWEEP: "LD",
    "MADHYA PRADESH": "MP",
    MAHARASHTRA: "MH",
    MANIPUR: "MN",
    MEGHALAYA: "ML",
    MIZORAM: "MZ",
    NAGALAND: "NL",
    ODISHA: "OD",
    ORISSA: "OD",
    PUDUCHERRY: "PY",
    PONDICHERRY: "PY",
    PUNJAB: "PB",
    RAJASTHAN: "RJ",
    SIKKIM: "SK",
    "TAMIL NADU": "TN",
    TAMILNADU: "TN",
    TELANGANA: "TS",
    TRIPURA: "TR",
    "UTTAR PRADESH": "UP",
    UTTARAKHAND: "UK",
    UTTARANCHAL: "UK",
    "WEST BENGAL": "WB",
};
const CODE_SET = new Set(Object.values(STATE_CODES));
export function stateCode(state) {
    const key = clean(state).toUpperCase().replace(/[.&]/g, " ").replace(/\s+/g, " ").trim();
    if (!key)
        return "";
    if (STATE_CODES[key])
        return STATE_CODES[key];
    const normalised = key.replace(/\bAND\b/g, "AND");
    if (STATE_CODES[normalised])
        return STATE_CODES[normalised];
    if (key.length === 2 && CODE_SET.has(key))
        return key;
    return "";
}
/**
 * The retailer syncId Mulltiply stores. The ERP customer code is the natural
 * stable key, but it can contain "/" (HO/A001) and their shop syncId is
 * "<customerSyncId>/<code>", so "/" becomes "-": HO/A001 → HO-A001.
 */
export function customerSyncId(customerCode) {
    return clean(customerCode).replace(/\//g, "-");
}
function address(row, firstName, mobile, code, kind) {
    const province = clean(row.state);
    return {
        syncId: null,
        address1: clean(row.address) || clean(row.city) || "-",
        address2: "",
        city: clean(row.city),
        province,
        provinceCode: code,
        country: clean(row.country) || "India",
        countryCode: "IN",
        zip: clean(row.pin_code),
        phoneCountryCode: "+91",
        phone: mobile,
        company: clean(row.customer_name),
        firstName,
        lastName: "",
        isDefault: true,
        isBillingAddress: kind === "billing",
        ...(kind === "shipping" ? { addressType: "SHIPPING_ADDRESS" } : {}),
    };
}
/**
 * Map one ERP customer (feed row) to one Mulltiply retailer with one primary
 * shop. Pure function. No balances leave the ERP (owner, 12-09-2026).
 */
export function customerToRetailer(row, _cfg) {
    const customerCode = clean(row.customer_code);
    const customerName = clean(row.customer_name);
    const warnings = [];
    if (!customerCode)
        return { status: "skip", customerCode, customerName, reason: "no customer code" };
    if (!customerName)
        return { status: "skip", customerCode, customerName, reason: "no customer name" };
    if (!row.mobile || !/^[6-9]\d{9}$/.test(row.mobile)) {
        return { status: "skip", customerCode, customerName, reason: "no valid mobile number" };
    }
    const syncId = customerSyncId(customerCode);
    const email = clean(row.email).toLowerCase();
    const validEmail = EMAIL_RE.test(email) ? email : "";
    if (email && !validEmail)
        warnings.push("email_dropped_invalid");
    const gst = clean(row.gstin).toUpperCase();
    const validGst = GSTIN_RE.test(gst) ? gst : "";
    if (gst && !validGst)
        warnings.push("gstin_dropped_invalid");
    const code = stateCode(clean(row.state));
    if (clean(row.state) && !code)
        warnings.push("state_code_unknown");
    if (!clean(row.address))
        warnings.push("no_address");
    if (!clean(row.pin_code))
        warnings.push("no_pincode");
    const alias = clean(row.alias_name);
    const billing = address(row, customerName, row.mobile, code, "billing");
    const shipping = address(row, customerName, row.mobile, code, "shipping");
    const retailer = {
        name: customerName,
        firstName: customerName,
        lastName: "",
        email: validEmail,
        phoneCountryCode: "+91",
        phone: row.mobile,
        syncId,
        note: `ERP ${customerCode}`,
        tags: alias ? [alias] : [],
        taxExempt: false,
        ...(validGst ? { gstNumber: validGst } : {}),
        billingAddress: billing,
        shops: [
            {
                syncId: `${syncId}/MAIN`,
                customerSyncId: syncId,
                shopName: customerName,
                city: clean(row.city),
                state: clean(row.state),
                pincode: clean(row.pin_code),
                ...(validGst ? { gstNumber: validGst } : {}),
                isPrimary: true,
                shippingAddress: shipping,
            },
        ],
    };
    return { status: "ok", retailer, warnings };
}
//# sourceMappingURL=transform.js.map