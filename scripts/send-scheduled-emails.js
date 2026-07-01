#!/usr/bin/env node
/**
 * Versendet automatisch:
 *  - Terminbestätigung: ca. 1 Tag vor dem Termin
 *  - Terminerinnerung:   am Termintag ab 9:00 Uhr (Europe/Berlin)
 *
 * Läuft alle 30 Minuten über GitHub Actions
 * (.github/workflows/send-scheduled-emails.yml) – siehe dort.
 *
 * Liest die Termine aus der Firestore-Collection "callSlots" (Felder
 * sendConfirmEmail / sendReminder, gesetzt von app.js beim Bestätigen
 * eines Termins) und die Mail-Texte/Signatur aus "settings/email"
 * (gespiegelt von app.js -> syncEmailSettings()).
 */

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const TIMEZONE = 'Europe/Berlin';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Fehlende Umgebungsvariable: ${name}`);
    process.exit(1);
  }
  return v;
}

const serviceAccount = JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT'));
const GMAIL_USER = requireEnv('GMAIL_USER');
const GMAIL_APP_PASSWORD = requireEnv('GMAIL_APP_PASSWORD');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

function pad(n) { return String(n).padStart(2, '0'); }

function formatDatum(dt) {
  return dt.toLocaleDateString('de-DE', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: TIMEZONE,
  });
}
function formatUhrzeit(dt) {
  return dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });
}
function berlinHour(d) {
  return parseInt(d.toLocaleTimeString('de-DE', { hour: '2-digit', hour12: false, timeZone: TIMEZONE }), 10);
}
function berlinDateKey(d) {
  // Liefert YYYY-MM-DD für den Kalendertag in Europe/Berlin
  return d.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
}

function fillTemplate(tpl, vars) {
  let out = tpl || '';
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v ?? '');
  }
  return out;
}

function generateICS(slot, organizerEmail) {
  const dt = new Date(slot.datetime);
  const dtEnd = new Date(dt.getTime() + (slot.apptDuration || 30) * 60000);
  const fmt = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  const uid = `termin-${Date.now()}-${Math.random().toString(36).slice(2)}@leadtracker`;
  const title = `${slot.apptType || 'Termin'}: ${slot.vorname || ''} ${slot.nachname || ''}`.trim();

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LeadTracker//DE',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${fmt(dt)}`,
    `DTEND:${fmt(dtEnd)}`,
    `SUMMARY:${title}`,
    `ORGANIZER;CN=Nawin:mailto:${organizerEmail}`,
    slot.email ? `ATTENDEE;CN=${slot.vorname || ''} ${slot.nachname || ''};RSVP=TRUE:mailto:${slot.email}` : '',
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Terminerinnerung',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

async function sendSlotMail({ slot, settings, type }) {
  const dt = new Date(slot.datetime);
  const datum = formatDatum(dt);
  const uhrzeit = formatUhrzeit(dt);
  const from = settings.gmailSender || GMAIL_USER;

  let subject, rawTemplate, withIcs;
  if (type === 'reminder') {
    subject = fillTemplate(settings.reminderSubject || 'Erinnerung: Unser Termin heute um {uhrzeit} Uhr', { datum, uhrzeit });
    rawTemplate = settings.emailReminderText;
    withIcs = false;
  } else {
    subject = fillTemplate(settings.confirmSubject || 'Terminbestätigung – {datum}', { datum, uhrzeit });
    rawTemplate = settings.emailConfirmText;
    withIcs = true;
  }

  const bodyText = fillTemplate(
    rawTemplate ||
`Hallo {vorname},

hiermit bestätige ich unseren gemeinsamen Termin am {datum} um {uhrzeit} Uhr.

Bei Fragen stehe ich dir gerne zur Verfügung.

{signatur}`,
    {
      vorname: slot.vorname || '',
      nachname: slot.nachname || '',
      datum,
      uhrzeit,
      signatur: settings.emailSig || '',
    }
  );

  const hasSigImage = !!settings.emailSigImage && bodyText.includes('{bild}');
  const htmlBody = bodyText
    .replace(/{bild}/g, hasSigImage
      ? `<img src="cid:sigimage" style="max-height:80px;max-width:200px;display:block;margin-top:6px;" alt="Signatur" />`
      : '')
    .replace(/\n/g, '<br>');

  const attachments = [];
  if (withIcs) {
    attachments.push({
      filename: 'termin.ics',
      content: generateICS(slot, from),
      contentType: 'text/calendar; method=REQUEST',
    });
  }
  if (hasSigImage) {
    const match = settings.emailSigImage.match(/^data:(.+);base64,(.+)$/);
    if (match) {
      attachments.push({
        filename: 'signatur.png',
        content: Buffer.from(match[2], 'base64'),
        cid: 'sigimage',
        contentType: match[1],
      });
    }
  }

  await transporter.sendMail({
    from: `Nawin Asuramuni <${GMAIL_USER}>`,
    to: slot.email,
    subject,
    html: htmlBody,
    attachments,
  });
}

async function main() {
  const settingsSnap = await db.collection('settings').doc('email').get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};

  const now = new Date();
  const todayKey = berlinDateKey(now);
  const hour = berlinHour(now);

  const slotsSnap = await db.collection('callSlots').get();
  let sentConfirm = 0;
  let sentReminder = 0;

  for (const docSnap of slotsSnap.docs) {
    const slot = docSnap.data();
    if (!slot.email || !slot.datetime) continue;

    const dt = new Date(slot.datetime);
    if (isNaN(dt.getTime()) || dt < now) continue; // vergangene Termine ignorieren

    // 1) Terminbestätigung – exakt 24 Stunden vorher
    // Der Job läuft alle 30 Minuten, daher reicht ein 24,5h-Fenster,
    // damit auch Termine, die auf :30 liegen, präzise (max. 30 Min. Abweichung) erwischt werden.
    if (slot.sendConfirmEmail && !slot.confirmEmailSent) {
      const hoursUntil = (dt - now) / 3600000;
      if (hoursUntil <= 24.5) {
        try {
          await sendSlotMail({ slot, settings, type: 'confirm' });
          await docSnap.ref.update({
            confirmEmailSent: true,
            confirmEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          sentConfirm++;
          console.log(`Bestätigung gesendet an ${slot.email} (${slot.vorname || ''})`);
        } catch (e) {
          console.error(`Fehler beim Senden der Bestätigung an ${slot.email}:`, e.message);
        }
      }
    }

    // 2) Terminerinnerung – am Termintag ab 9 Uhr
    if (slot.sendReminder && !slot.reminderSent) {
      const dtKey = berlinDateKey(dt);
      if (dtKey === todayKey && hour >= 9) {
        try {
          await sendSlotMail({ slot, settings, type: 'reminder' });
          await docSnap.ref.update({
            reminderSent: true,
            reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          sentReminder++;
          console.log(`Erinnerung gesendet an ${slot.email} (${slot.vorname || ''})`);
        } catch (e) {
          console.error(`Fehler beim Senden der Erinnerung an ${slot.email}:`, e.message);
        }
      }
    }
  }

  console.log(`Fertig. ${sentConfirm} Bestätigung(en), ${sentReminder} Erinnerung(en) versendet.`);
}

main().catch(e => {
  console.error('Unerwarteter Fehler:', e);
  process.exit(1);
});
