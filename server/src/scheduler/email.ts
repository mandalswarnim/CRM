import fs from 'node:fs';
import path from 'node:path';
import type { DbClient } from '../db/index.js';
import { config } from '../config.js';

export interface OutboundEmail {
  id: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
}

function parseJson<T>(value: any, fallback: T): T {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** RFC 5322 message, written verbatim by the file transport so it can be inspected or replayed. */
function renderEml(email: OutboundEmail, from: string): string {
  const headers = [
    `From: ${from}`,
    `To: ${email.to_addrs.join(', ')}`,
    ...(email.cc_addrs.length ? [`Cc: ${email.cc_addrs.join(', ')}`] : []),
    `Subject: ${email.subject ?? ''}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: ${email.body_html ? 'text/html' : 'text/plain'}; charset=utf-8`
  ];
  return `${headers.join('\r\n')}\r\n\r\n${email.body_html ?? email.body_text ?? ''}`;
}

/**
 * Send queued mail.
 *
 * The default transport writes .eml files to disk, so the platform works offline and nothing is
 * accidentally sent to a real member's address during development. SMTP is opt-in via
 * EMAIL_TRANSPORT=smtp.
 */
export async function dispatchQueuedEmail(c: DbClient, orgId: string, limit = 50): Promise<number> {
  const rows = await c.query<any>(
    `SELECT id, to_addrs, cc_addrs, subject, body_text, body_html
       FROM email_outbound WHERE status = 'Queued' ORDER BY created_at LIMIT $1`,
    [limit]
  );
  if (!rows.rows.length) return 0;

  let sent = 0;
  for (const row of rows.rows) {
    const email: OutboundEmail = {
      id: row.id,
      to_addrs: parseJson<string[]>(row.to_addrs, []),
      cc_addrs: parseJson<string[]>(row.cc_addrs, []),
      subject: row.subject,
      body_text: row.body_text,
      body_html: row.body_html
    };

    try {
      if (!email.to_addrs.length) throw new Error('no recipients');
      if (config.emailTransport === 'smtp') {
        await sendViaSmtp(email);
      } else {
        const dir = path.join(config.dataDir, 'outbox', orgId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${email.id}.eml`), renderEml(email, 'noreply@meridian.local'), 'utf8');
      }
      await c.query(`UPDATE email_outbound SET status = 'Sent', sent_at = now(), error = NULL WHERE id = $1`, [email.id]);
      sent++;
    } catch (err) {
      // A failed send is recorded, not retried forever; the row stays visible for an operator.
      await c.query(`UPDATE email_outbound SET status = 'Failed', error = $2 WHERE id = $1`, [
        email.id,
        String((err as Error)?.message ?? err)
      ]);
    }
  }
  return sent;
}

async function sendViaSmtp(email: OutboundEmail): Promise<void> {
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport(config.smtpUrl);
  await transport.sendMail({
    from: process.env.EMAIL_FROM ?? 'noreply@meridian.local',
    to: email.to_addrs.join(', '),
    cc: email.cc_addrs.length ? email.cc_addrs.join(', ') : undefined,
    subject: email.subject ?? '',
    text: email.body_text ?? undefined,
    html: email.body_html ?? undefined
  });
}
