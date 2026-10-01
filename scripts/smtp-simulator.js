import { startSmtpSimulator } from '../backend/mail/smtp-simulator.js';

await startSmtpSimulator({ outboxFile: process.env.MAIL_OUTBOX ?? 'data/mail.outbox' });
console.log(`SMTP simulator listening on ${process.env.SMTP_PORT ?? 2525}`);
