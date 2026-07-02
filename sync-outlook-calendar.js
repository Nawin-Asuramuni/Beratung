// ============================================================
// Outlook → Google Calendar Sync
// Liest den öffentlichen ICS-Link von Outlook/Exchange aus und
// spiegelt die Termine 1:1 in ein Google Calendar (nawin.telis@gmail.com).
// Läuft automatisch per GitHub Actions (siehe .github/workflows/sync-outlook-calendar.yml)
// ============================================================

const ical = require('node-ical');
const { google } = require('googleapis');
const crypto = require('crypto');

const ICS_URL            = process.env.OUTLOOK_ICS_URL;
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const TARGET_CALENDAR_ID   = process.env.TARGET_CALENDAR_ID || 'nawin.telis@gmail.com';

// Wie weit in die Vergangenheit/Zukunft synchronisiert wird
const SYNC_PAST_DAYS   = 7;
const SYNC_FUTURE_DAYS = 120;

// Marker, mit dem synchronisierte Events eindeutig als "von Outlook" erkannt werden
const SYNC_TAG = 'outlook-sync';

function requireEnv() {
  const missing = [];
  if (!ICS_URL) missing.push('OUTLOOK_ICS_URL');
  if (!GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!GOOGLE_REFRESH_TOKEN) missing.push('GOOGLE_REFRESH_TOKEN');
  if (missing.length) {
    console.error('❌ Fehlende Umgebungsvariablen/Secrets:', missing.join(', '));
    process.exit(1);
  }
}

// Stabile, kurze ID aus der Outlook-UID ableiten (Google erlaubt nur [a-v0-9] als eigene Event-ID)
function stableId(uid) {
  const hash = crypto.createHash('sha1').update(uid).digest('hex');
  return 'outlk' + hash.slice(0, 20); // nur a-v/0-9 nötig -> hex passt (0-9a-f ⊂ 0-9a-v)
}

async function getGoogleAuth() {
  const oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

async function fetchOutlookEvents() {
  console.log('📥 Lade Outlook-Kalender (ICS)...');
  const data = await ical.async.fromURL(ICS_URL);

  const now = new Date();
  const rangeStart = new Date(now.getTime() - SYNC_PAST_DAYS * 86400000);
  const rangeEnd   = new Date(now.getTime() + SYNC_FUTURE_DAYS * 86400000);

  const events = [];
  for (const key of Object.keys(data)) {
    const item = data[key];
    if (item.type !== 'VEVENT') continue;
    if (!item.start || !item.end) continue;

    const isAllDay = item.start.dateOnly === true;

    // Wiederkehrende Termine: node-ical liefert Ausnahmen/Wiederholungen über item.rrule + recurrences
    if (item.rrule) {
      const occurrences = item.rrule.between(rangeStart, rangeEnd, true);
      for (const occStart of occurrences) {
        const duration = item.end.getTime() - item.start.getTime();
        const occEnd = new Date(occStart.getTime() + duration);
        const dateKey = occStart.toISOString().slice(0, 10);
        // Falls für dieses Datum eine bearbeitete Ausnahme existiert, die stattdessen nehmen
        const exception = item.recurrences && Object.values(item.recurrences).find(r => {
          return new Date(r.start).toISOString().slice(0, 10) === dateKey;
        });
        const finalItem = exception || { start: occStart, end: occEnd, summary: item.summary, location: item.location, description: item.description };
        events.push(toEvent(item.uid + '_' + dateKey, finalItem, isAllDay));
      }
      continue;
    }

    if (item.start < rangeStart || item.start > rangeEnd) continue;
    events.push(toEvent(item.uid, item, isAllDay));
  }
  console.log(`✅ ${events.length} Outlook-Termine im Sync-Zeitraum gefunden`);
  return events;
}

function toEvent(uid, item, isAllDay) {
  return {
    uid: String(uid),
    title: item.summary || '(Ohne Titel)',
    location: item.location || '',
    description: item.description || '',
    start: item.start,
    end: item.end,
    allDay: isAllDay,
  };
}

function buildGoogleEventBody(ev) {
  const body = {
    summary: ev.title,
    location: ev.location,
    description: ev.description,
    extendedProperties: {
      private: {
        [SYNC_TAG]: 'true',
        outlookUid: ev.uid,
      },
    },
  };
  if (ev.allDay) {
    body.start = { date: ev.start.toISOString().slice(0, 10) };
    body.end   = { date: ev.end.toISOString().slice(0, 10) };
  } else {
    body.start = { dateTime: ev.start.toISOString(), timeZone: 'Europe/Berlin' };
    body.end   = { dateTime: ev.end.toISOString(),   timeZone: 'Europe/Berlin' };
  }
  return body;
}

async function main() {
  requireEnv();
  const auth = await getGoogleAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const outlookEvents = await fetchOutlookEvents();
  const outlookByUid = new Map(outlookEvents.map(e => [e.uid, e]));

  // Bereits vorhandene, früher synchronisierte Google-Events laden
  console.log('📥 Lade bereits synchronisierte Google-Calendar-Events...');
  let existing = [];
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId: TARGET_CALENDAR_ID,
      privateExtendedProperty: `${SYNC_TAG}=true`,
      showDeleted: false,
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    });
    existing = existing.concat(res.data.items || []);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  console.log(`ℹ️  ${existing.length} bereits synchronisierte Events in Google Calendar gefunden`);

  const existingByUid = new Map(
    existing.map(e => [e.extendedProperties?.private?.outlookUid, e])
  );

  let created = 0, updated = 0, deleted = 0, unchanged = 0;

  // Neue / geänderte Termine schreiben
  for (const [uid, ev] of outlookByUid) {
    const body = buildGoogleEventBody(ev);
    const match = existingByUid.get(uid);

    if (!match) {
      await calendar.events.insert({
        calendarId: TARGET_CALENDAR_ID,
        requestBody: { ...body, id: stableId(uid) },
      });
      created++;
      continue;
    }

    const changed =
      match.summary !== body.summary ||
      match.location !== body.location ||
      (match.start?.dateTime || match.start?.date) !== (body.start.dateTime || body.start.date) ||
      (match.end?.dateTime || match.end?.date) !== (body.end.dateTime || body.end.date);

    if (changed) {
      await calendar.events.update({
        calendarId: TARGET_CALENDAR_ID,
        eventId: match.id,
        requestBody: body,
      });
      updated++;
    } else {
      unchanged++;
    }
  }

  // Termine löschen, die in Outlook nicht mehr existieren
  for (const [uid, match] of existingByUid) {
    if (!outlookByUid.has(uid)) {
      try {
        await calendar.events.delete({ calendarId: TARGET_CALENDAR_ID, eventId: match.id });
        deleted++;
      } catch (e) {
        console.warn(`⚠️  Löschen fehlgeschlagen für ${match.id}:`, e.message);
      }
    }
  }

  console.log(`\n✅ Sync fertig — neu: ${created}, aktualisiert: ${updated}, gelöscht: ${deleted}, unverändert: ${unchanged}`);
}

main().catch(err => {
  console.error('❌ Sync fehlgeschlagen:', err);
  process.exit(1);
});
