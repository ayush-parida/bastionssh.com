import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/index.js';

const SEND_TIMEOUT_MS = 15_000;

let transport: Transporter | null = null;

/** Email channels can only exist when the operator configured SMTP. */
export function emailAvailable(): boolean {
  return config.smtp !== null;
}

function getTransport(): Transporter {
  if (!config.smtp) {
    throw new Error('Email delivery is not configured (set SMT_SMTP_URL and SMT_SMTP_FROM)');
  }
  if (!transport) {
    // nodemailer accepts the smtp:// / smtps:// URL form directly.
    transport = nodemailer.createTransport({
      url: config.smtp.url,
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
  }
  return transport;
}

/** Drop the cached transport so the next send rebuilds it (tests, config reload). */
export function resetTransport(): void {
  transport = null;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  await getTransport().sendMail({
    from: config.smtp!.from,
    to: msg.to.join(', '),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}
