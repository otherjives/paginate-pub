// src/email.ts — Email Service tools for paginate-pub.
//
// Policy (locked in with the owner): outbound sending is restricted to
// VERIFIED DESTINATION ADDRESSES, which is free on all plans. Sending to
// arbitrary recipients requires the Workers Paid plan ($5/mo, 3,000 emails/mo
// included, then $0.35/1,000) and is disabled by default. `send_email`
// refuses and explains rather than sending in that case.

import { CfClient } from "./cf";
import { logOp, jsonText, errText } from "./util";

export interface EmailEnv {
  DB: D1Database;
  CF_API_TOKEN: string;
  ACCOUNT_ID: string;
  ZONE_ID: string;
  DOMAIN: string;
  EMAIL?: SendEmail;
}

async function verifiedDestinations(env: EmailEnv): Promise<Set<string>> {
  const cf = new CfClient(env);
  const list = await cf.listEmailAddresses();
  return new Set(list.map((a: any) => String(a.email).toLowerCase()));
}

import { EmailMessage } from "cloudflare:email";
import { z } from "zod";

// The Workers Email binding takes a constructed EmailMessage with raw MIME
// (not a plain object). Builds a minimal multipart/alternative message.
export async function sendMimeEmail(
  binding: any,
  from: string,
  to: string,
  subject: string,
  text: string,
  html?: string,
): Promise<void> {
  const boundary = "pp_" + Date.now().toString(36);
  const headers = [
    `From: paginate-pub <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
  ];
  let raw: string;
  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    raw =
      headers.join("\r\n") + "\r\n" +
      `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n` +
      `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n` +
      `--${boundary}--\r\n`;
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8");
    raw = headers.join("\r\n") + "\r\n\r\n" + text + "\r\n";
  }
  await binding.send(new EmailMessage(from, to, raw));
}

export function registerEmailTools(server: any, env: EmailEnv, actor: string = "unknown") {

  server.registerTool(
    "send_email",
    {
      title: "Send an email from the domain",
      description:
        "Send an email from an address on the domain (e.g. hello@paginate.dev). " +
        "FREE tier: only to verified destination addresses (add them first with " +
        "add_email_address). Sending to anyone else needs a paid plan; this tool " +
        "will refuse and explain rather than send in that case.",
      inputSchema: {
        to: z.string().describe("Recipient email address."),
        subject: z.string(),
        body_text: z.string().optional().describe("Plain-text body."),
        body_html: z.string().optional().describe("HTML body."),
        from: z.string().optional().describe("Sender, e.g. hello@paginate.dev. Defaults to hello@<domain>."),
      },
    },
    async ({ to, subject, body_text, body_html, from }: any) => {
      try {
        if (!env.EMAIL) return errText("Email binding not configured on this Worker.");
        const dest = to.trim().toLowerCase();
        const verified = await verifiedDestinations(env);
        if (!verified.has(dest)) {
          return errText(
            `${dest} is not a verified destination address. Sending to arbitrary ` +
            `recipients requires the Workers Paid plan ($5/mo, 3,000 emails/mo ` +
            `included, then $0.35 per 1,000). Add ${dest} as a verified destination ` +
            `address first with add_email_address (free), or ask the owner to enable ` +
            `paid sending. No email was sent.`,
          );
        }
        const sender = from ?? `hello@${env.DOMAIN}`;
        await sendMimeEmail(
          env.EMAIL,
          sender,
          dest,
          subject,
          body_text ?? "",
          body_html,
        );
        await logOp(env.DB, "send_email", { to: dest, subject }, true, actor);
        return jsonText({ sent: true, to: dest, from: sender });
      } catch (e) {
        await logOp(env.DB, "send_email", { error: String(e) }, false, actor);
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "add_email_address",
    {
      title: "Add a verified email destination",
      description:
        "Add an email address as a verified destination. You must click the " +
        "verification link Cloudflare sends to that address. Sending to verified " +
        "destinations is free.",
      inputSchema: { email: z.string() },
    },
    async ({ email }: any) => {
      try {
        const cf = new CfClient(env);
        const r = await cf.createEmailAddress(email.trim().toLowerCase());
        await logOp(env.DB, "add_email_address", { email }, true, actor);
        return jsonText({
          added: true,
          email: r.email,
          verified: r.verified,
          note: "A verification email was sent. The address must be verified before sends to it work.",
        });
      } catch (e) {
        await logOp(env.DB, "add_email_address", { error: String(e) }, false, actor);
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "list_email_addresses",
    {
      title: "List verified email destinations",
      description: "List all verified destination addresses (the free send-to list).",
      inputSchema: {},
    },
    async () => {
      try {
        const cf = new CfClient(env);
        const list = await cf.listEmailAddresses();
        return jsonText({
          count: list.length,
          addresses: list.map((a: any) => ({ email: a.email, verified: a.verified, id: a.id })),
        });
      } catch (e) {
        return errText(String(e));
      }
    },
  );

  server.registerTool(
    "add_email_route",
    {
      title: "Add an inbound email route",
      description:
        "Route inbound email (e.g. contact@paginate.dev) to a verified destination " +
        "address. Inbound routing is free and unlimited.",
      inputSchema: {
        match: z.string().describe("Address to match, e.g. contact@paginate.dev"),
        forward_to: z.string().describe("Verified destination address to forward to."),
      },
    },
    async ({ match, forward_to }: any) => {
      try {
        const cf = new CfClient(env);
        const r = await cf.createEmailRule({
          name: `paginate-pub route ${match}`,
          matchers: [{ type: "literal", pattern: match.trim().toLowerCase() }],
          actions: [{ type: "forward", value: [forward_to.trim().toLowerCase()] }],
          enabled: true,
        });
        await logOp(env.DB, "add_email_route", { match, forward_to }, true, actor);
        return jsonText({ routed: true, match, forward_to, id: r.id });
      } catch (e) {
        await logOp(env.DB, "add_email_route", { error: String(e) }, false, actor);
        return errText(String(e));
      }
    },
  );
}
