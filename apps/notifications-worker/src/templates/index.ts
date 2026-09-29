/**
 * Static email templates for the notifications worker.
 *
 * Spec 14 allows V1 templates to be static files as long as template
 * versions remain traceable — these renderers are the V1 "static files"
 * form, keyed by the same `templateKey` strings the calling workers pass
 * to POST /v1/notifications.
 *
 * Every substitution is HTML-escaped before it reaches the html body, so a
 * hostile value in `templateData` (or a recipient-controlled field such as
 * an email hint) can never inject markup. Renderers only read the fields
 * they need; unknown extra fields are ignored, and unknown template keys
 * return null so the provider can fail the send with a bounded reason
 * instead of delivering an empty message.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type TemplateData = Record<string, string | number | boolean | null>;

export interface TemplateRenderOptions {
  /**
   * Product display name used in subjects/footers (e.g. "Leakbook").
   * Falls back to neutral copy when not configured so a misconfigured
   * deployment still produces a sensible email.
   */
  brandName?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Stringify a templateData value; null/undefined render as "". */
function str(data: TemplateData, key: string): string {
  const v = data[key];
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * Render an ISO timestamp as a human-readable UTC string. Falls back to the
 * raw value when it does not parse — a slightly ugly email beats a failed
 * send.
 */
function formatTimestamp(raw: string): string {
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toUTCString();
}

/**
 * Shared shell so all transactional emails look consistent. Body fragments
 * passed in MUST already be escaped.
 */
function htmlShell(title: string, bodyHtml: string, footerLine: string): string {
  return [
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background-color:#f4f4f7;">',
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;color:#1a1a2e;">',
    '<div style="background:#ffffff;border-radius:8px;padding:32px;">',
    `<h1 style="margin:0 0 16px;font-size:20px;">${title}</h1>`,
    bodyHtml,
    "</div>",
    `<p style="margin:16px 0 0;font-size:12px;color:#6b6b80;text-align:center;">${footerLine}</p>`,
    "</div></body></html>",
  ].join("");
}

type TemplateRenderer = (data: TemplateData, opts: TemplateRenderOptions) => RenderedEmail;

const renderMagicLink: TemplateRenderer = (data, opts) => {
  const code = str(data, "code");
  const expires = formatTimestamp(str(data, "expiresAt"));
  const brand = opts.brandName ?? "";
  const subject = brand ? `Your ${brand} login code` : "Your login code";
  const expiryLineText = expires ? `This code expires at ${expires}.` : "This code expires shortly.";

  const text = [
    "Use this code to finish signing in:",
    "",
    code,
    "",
    expiryLineText,
    "If you did not request this code, you can safely ignore this email.",
  ].join("\n");

  const html = htmlShell(
    "Finish signing in",
    [
      '<p style="margin:0 0 16px;font-size:14px;">Use this code to finish signing in:</p>',
      `<p style="margin:0 0 16px;font-size:28px;font-weight:700;letter-spacing:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(code)}</p>`,
      `<p style="margin:0 0 8px;font-size:13px;color:#6b6b80;">${escapeHtml(expiryLineText)}</p>`,
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If you did not request this code, you can safely ignore this email.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated security email."),
  );

  return { subject, html, text };
};

const renderInvitationCreated: TemplateRenderer = (data, opts) => {
  const role = str(data, "role");
  const expires = formatTimestamp(str(data, "expiresAt"));
  const brand = opts.brandName ?? "";
  const subject = brand
    ? `You have been invited to an organization on ${brand}`
    : "You have been invited to an organization";
  const roleLineText = role
    ? `You have been invited to join an organization as ${role}.`
    : "You have been invited to join an organization.";
  const expiryLineText = expires ? `The invitation expires at ${expires}.` : "";

  const text = [
    roleLineText,
    expiryLineText,
    "Sign in with this email address to view and accept the invitation.",
    "If you were not expecting this invitation, you can safely ignore this email.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");

  const html = htmlShell(
    "You have been invited",
    [
      `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(roleLineText)}</p>`,
      expiryLineText
        ? `<p style="margin:0 0 16px;font-size:13px;color:#6b6b80;">${escapeHtml(expiryLineText)}</p>`
        : "",
      '<p style="margin:0 0 8px;font-size:14px;">Sign in with this email address to view and accept the invitation.</p>',
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If you were not expecting this invitation, you can safely ignore this email.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );

  return { subject, html, text };
};

const renderInvitationAccepted: TemplateRenderer = (data, opts) => {
  const role = str(data, "role");
  const brand = opts.brandName ?? "";
  const subject = brand ? `You have joined an organization on ${brand}` : "You have joined an organization";
  const bodyLineText = role
    ? `Your invitation was accepted and you are now a member with the ${role} role.`
    : "Your invitation was accepted and you are now a member of the organization.";

  const text = [
    bodyLineText,
    "If this was not you, contact your organization administrator.",
  ].join("\n\n");

  const html = htmlShell(
    "Welcome aboard",
    [
      `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(bodyLineText)}</p>`,
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If this was not you, contact your organization administrator.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );

  return { subject, html, text };
};

/**
 * Leakbook's repair clock (LB3). One renderer per message: the clock opened,
 * a reminder rung (14 / 7 / 3 / 1 / 0 days before the deadline), the deadline
 * missed (to the contractor's admins), and the escalation to the site's owner
 * contact. `templateData` carries the appliance and site names, the rate, and
 * the dates; nothing else.
 */
function leakDaysPhrase(days: number): string {
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`;
  if (days === 0) return "due today";
  return `due in ${days} day${days === 1 ? "" : "s"}`;
}

type LeakClockMessage = "opened" | "reminder" | "overdue" | "escalation";

function leakClockRenderer(message: LeakClockMessage): TemplateRenderer {
  return (data, opts) => {
    const appliance = str(data, "applianceName") || "An appliance";
    const site = str(data, "siteName");
    const where = site ? `${appliance} at ${site}` : appliance;
    const rate = str(data, "leakRate");
    const threshold = str(data, "thresholdPct");
    const regime = str(data, "regime");
    const openedOn = str(data, "openedOn");
    const dueOn = str(data, "dueOn");
    const kind = str(data, "deadlineKind") === "followup" ? "follow-up verification test" : "repair";
    const days = Number(data.daysLeft ?? 0);
    const phrase = leakDaysPhrase(Number.isFinite(days) ? days : 0);
    const brand = opts.brandName ?? "";
    const rule = regime ? `40 CFR ${regime}` : "the leak-repair rule";

    let subject: string;
    let title: string;
    let lead: string;
    let tail: string;
    switch (message) {
      case "opened":
        subject = `Repair clock started: ${where}`;
        title = "A leak repair is now due";
        lead = `${where} leaked at ${rate} a year on ${openedOn}, over its ${threshold} % threshold. Under ${rule} the leak must be repaired by ${dueOn}.`;
        tail = "Log the repair, then the initial and follow-up verification tests, from the unit's QR label. The clock closes when the follow-up test passes.";
        break;
      case "reminder":
        subject = `${kind === "repair" ? "Repair" : "Follow-up test"} ${phrase}: ${where}`;
        title = kind === "repair" ? "Repair deadline approaching" : "Follow-up test deadline approaching";
        lead = `The ${kind} on ${where} is ${phrase} (${dueOn}). It leaked at ${rate} against a ${threshold} % threshold on ${openedOn}.`;
        tail = "Once it is logged from the unit's label, the remaining reminders stop.";
        break;
      case "overdue":
        subject = `Overdue: ${kind} on ${where}`;
        title = "Leak repair deadline missed";
        lead = `The ${kind} on ${where} was due ${dueOn} and has not been logged. The leak (${rate}, threshold ${threshold} %) was found on ${openedOn}.`;
        tail = `A missed deadline under ${rule} may need to be reported. The site's owner contact has been told as well.`;
        break;
      default:
        subject = `Leak repair overdue at ${site || "your site"}`;
        title = "A leak repair at your site is overdue";
        lead = `Your service contractor found a leak on ${appliance}${site ? ` at ${site}` : ""} on ${openedOn} (${rate} a year, over the ${threshold} % threshold). The ${kind} was due ${dueOn} and has not been recorded yet.`;
        tail = `As the owner or operator you are responsible for the repair under ${rule}. Please contact your contractor.`;
    }

    const text = [lead, "", tail].join("\n");
    const html = htmlShell(
      escapeHtml(title),
      [
        `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(lead)}</p>`,
        `<p style="margin:0;font-size:13px;color:#6b6b80;">${escapeHtml(tail)}</p>`,
      ].join(""),
      escapeHtml(brand ? `Sent by ${brand}` : "This is an automated reminder."),
    );
    return { subject: brand ? `[${brand}] ${subject}` : subject, html, text };
  };
}

const TEMPLATES: Record<string, TemplateRenderer> = {
  "auth.magic_link": renderMagicLink,
  "invitation.created": renderInvitationCreated,
  "invitation.accepted": renderInvitationAccepted,
  "leak.clock.opened": leakClockRenderer("opened"),
  "leak.clock.reminder": leakClockRenderer("reminder"),
  "leak.clock.overdue": leakClockRenderer("overdue"),
  "leak.clock.escalation": leakClockRenderer("escalation"),
};

/**
 * Render the email for a template key, or null when the key has no
 * registered template. Callers (the provider adapters) MUST treat null as a
 * bounded send failure — never deliver an empty or generic body.
 */
export function renderEmailTemplate(
  templateKey: string,
  templateData: TemplateData,
  opts: TemplateRenderOptions = {},
): RenderedEmail | null {
  const renderer = TEMPLATES[templateKey];
  if (!renderer) return null;
  return renderer(templateData, opts);
}
