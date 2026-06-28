// ============================================================
// FIREBASE KONFIGURATION – deine Zugangsdaten
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.3.1/firebase-app.js";
import {
  getFirestore, collection, addDoc, getDocs, doc,
  updateDoc, deleteDoc, onSnapshot, orderBy, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.3.1/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.3.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBxiDftvsNOfElvrt8hhLaUA0HDoSyuK-g",
  authDomain: "tracking-74513.firebaseapp.com",
  projectId: "tracking-74513",
  storageBucket: "tracking-74513.firebasestorage.app",
  messagingSenderId: "621239887005",
  appId: "1:621239887005:web:5b962abff5c9109a546074",
  measurementId: "G-ZF74396S74"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
// Gmail-Versand & Kalender-Zugriff direkt beim Login mit anfordern,
// damit nur noch EIN Google-Popup nötig ist statt mehrerer separater.
provider.addScope('https://www.googleapis.com/auth/gmail.send');
provider.addScope('https://www.googleapis.com/auth/calendar.events');

// ============================================================
// DEFAULT SETTINGS INIT (vor allem anderen)
// ============================================================
(function initDefaultSettings() {
  const existing = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  if (!existing.apptTypes || existing.apptTypes.length === 0) {
    existing.apptTypes = [
      { name: 'Erstgespräch',    color: '#3b82f6', duration: 30 },
      { name: 'Beratungstermin', color: '#a78bfa', duration: 60 },
      { name: 'Folgegespräch',   color: '#22c55e', duration: 20 },
    ];
    localStorage.setItem('crmSettings', JSON.stringify(existing));
  }
})();

// ============================================================
// STATE
// ============================================================
let contacts = [];
let callSlots = [];          // geschäftliche Termine (privateBooking !== true)
let privateSlots = [];       // private Termine (privateBooking === true)
let currentContactId = null;
let editingContactId = null;
let editingHistoryContactId = null;
let currentPage = 'dashboard';

// ============================================================
// HELPERS
// ============================================================
function toast(msg, type = 'success') {
  const icon = type === 'success' ? 'ti-check' : 'ti-alert-circle';
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="ti ${icon}"></i> ${msg}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
window.toast = toast; // Expose for inline onclick handlers

function fmtDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function statusBadge(status) {
  if (!status) return '<span class="badge badge-neu">—</span>';
  const s = status.toLowerCase();
  let cls = 'badge-neu';
  if (s.includes('kontakt')) cls = 'badge-kontaktiert';
  else if (s.includes('termin')) cls = 'badge-termin';
  else if (s.includes('angebot')) cls = 'badge-angebot';
  else if (s.includes('abgeschlossen') || s.includes('erfolg')) cls = 'badge-abgeschlossen';
  else if (s.includes('absag') || s.includes('nein') || s.includes('verloren')) cls = 'badge-abgesagt';
  return `<span class="badge ${cls}">${status}</span>`;
}

function now() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0,16);
}

// ============================================================
// FIRESTORE DATA LOADING
// ============================================================
async function loadContacts() {
  const q = query(collection(db, 'contacts'), orderBy('createdAt', 'desc'));
  onSnapshot(q, snap => {
    contacts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentPage === 'dashboard') renderDashboard();
    if (currentPage === 'contacts') renderContacts();
    if (currentPage === 'calendar') renderCalendar();
    if (currentPage === 'export') renderExport();
  }, err => {
    console.warn('Firestore not connected, using local data:', err.message);
  });
}

async function loadCallSlots() {
  const q = query(collection(db, 'callSlots'), orderBy('datetime', 'asc'));
  onSnapshot(q, snap => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // ── Strikte Trennung: privat vs. geschäftlich ────────────────
    privateSlots = all.filter(s => s.privateBooking === true);
    callSlots    = all.filter(s => !s.privateBooking);
    // ─────────────────────────────────────────────────────────────
    if (currentPage === 'dashboard') renderDashboard();
    if (currentPage === 'calendar') renderCalendar();
    // Buchungs-Dialog aktualisieren falls offen
    if (document.getElementById('callSlotModal')?.classList.contains('open')) {
      const step2 = document.getElementById('cs_step2');
      if (step2 && step2.style.display !== 'none') _csRenderCal();
    }
  }, () => {});
}

// ============================================================
// NAVIGATION
// ============================================================
const pages = {
  dashboard: { title: 'Dashboard', render: renderDashboard },
  contacts:  { title: 'Kontakte',  render: renderContacts },
  calendar:  { title: 'Wochenplan', render: renderCalendar },
  export:    { title: 'Export / Monday', render: renderExport },
  settings:  { title: 'Einstellungen', render: renderSettings },
  kleinanzeigen: { title: 'Kleinanzeigen', render: () => window.renderKleinanzeigen?.() },
  socialmedia:   { title: 'Social Media', render: () => window.openSocialMediaPanel?.() },
};
window.pages = pages; // Expose for kleinanzeigen.js (ES-Module scope fix)

function navigate(page) {
  // Falls Notizen- oder Social-Media-Overlay offen ist: erst schließen
  const notesPanel = document.getElementById('notes-panel-embed');
  if (notesPanel && notesPanel.style.display !== 'none') {
    notesPanel.classList.remove('panel-visible');
    notesPanel.classList.add('panel-closing');
    document.body.style.overflow = '';
    setTimeout(() => {
      notesPanel.style.display = 'none';
      notesPanel.classList.remove('panel-closing');
    }, 220);
  }
  const smPanel = document.getElementById('socialmedia-panel-embed');
  if (smPanel && smPanel.style.display !== 'none' && page !== 'socialmedia') {
    smPanel.classList.remove('panel-visible');
    smPanel.classList.add('panel-closing');
    document.body.style.overflow = '';
    setTimeout(() => {
      smPanel.style.display = 'none';
      smPanel.classList.remove('panel-closing');
    }, 220);
  }

  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
  document.getElementById('pageTitle').textContent = pages[page].title;
  closeSidebar();
  pages[page].render();
}

// ── Notizen-Overlay – nutzt eingebettetes Panel (notes.html ist direkt in tracker.html) ──
// Hinweis: Die eigentliche, vollständige Implementierung (inkl. Lazy-Init der
// Notizen-Daten und Slide-Animation) wird am Ende von tracker.html als
// window.openNotesOverlay registriert. Diese lokale Funktion dient nur als
// Fallback, falls dieses Skript aus irgendeinem Grund fehlen sollte.
function openNotesOverlay() {
  const panel = document.getElementById('notes-panel-embed');
  if (!panel) return;
  panel.style.display = 'flex';
  panel.classList.add('panel-visible');
  document.body.style.overflow = 'hidden';
  closeSidebar();
  if (window._initNotesPanel) window._initNotesPanel();

  // Zurück-Button verkabeln
  const backBtn = document.getElementById('notes-panel-back');
  if (backBtn) {
    backBtn.onclick = function() {
      panel.classList.remove('panel-visible');
      panel.style.display = 'none';
      document.body.style.overflow = '';
      openSidebar();
    };
  }
}

document.querySelectorAll('.nav-item').forEach(n => {
  n.addEventListener('click', e => {
    e.preventDefault();
    // Auth-Check für alle Links
    if (!auth.currentUser || auth.currentUser.email !== ALLOWED_EMAIL) return;
    // Notizen-Link → Overlay statt externer Seite
    if (n.classList.contains('nav-external')) {
      (window.openNotesOverlay || openNotesOverlay)();
      return;
    }
    navigate(n.dataset.page);
  });
});

document.getElementById('topAddBtn').addEventListener('click', () => {
  if (currentPage === 'calendar') openCallSlotModal();
  else openContactModal();
});

// ============================================================
// SIDEBAR
// ============================================================
function openSidebar() {
  // Sidebar nur öffnen wenn eingeloggt
  if (!auth.currentUser || auth.currentUser.email !== ALLOWED_EMAIL) return;
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('overlay').classList.add('show');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
}
document.getElementById('menuBtn').addEventListener('click', openSidebar);
document.getElementById('sidebarClose').addEventListener('click', closeSidebar);
document.getElementById('overlay').addEventListener('click', closeSidebar);
window.openSidebar  = openSidebar;
window.closeSidebar = closeSidebar;

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  const total = contacts.length;
  const neu = contacts.filter(c => c.status === 'neu').length;
  const termin = contacts.filter(c => c.status === 'termin').length;
  const abgeschlossen = contacts.filter(c => c.status === 'abgeschlossen').length;
  const abgesagt = contacts.filter(c => c.status === 'abgesagt').length;

  const recent = [...contacts].slice(0, 5);

  document.getElementById('content').innerHTML = `
    <div class="stats-grid">
      <div class="stat-card blue"><div class="stat-label">Gesamt</div><div class="stat-value">${total}</div><div class="stat-sub">Kontakte</div></div>
      <div class="stat-card amber"><div class="stat-label">Neu</div><div class="stat-value">${neu}</div><div class="stat-sub">Offen</div></div>
      <div class="stat-card purple"><div class="stat-label">Termine</div><div class="stat-value">${termin}</div><div class="stat-sub">Vereinbart</div></div>
      <div class="stat-card green"><div class="stat-label">Abgeschlossen</div><div class="stat-value">${abgeschlossen}</div><div class="stat-sub">Erfolgreich</div></div>
      <div class="stat-card red"><div class="stat-label">Abgesagt</div><div class="stat-value">${abgesagt}</div><div class="stat-sub">Verloren</div></div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <h2 style="font-size:15px;font-weight:600;">Letzte Kontakte</h2>
      <button class="btn-ghost" style="font-size:13px;padding:6px 12px;" onclick="navigate('contacts')">Alle anzeigen</button>
    </div>

    ${recent.length === 0 ? `<div class="empty-state"><i class="ti ti-users"></i><p>Noch keine Kontakte. Lege deinen ersten an!</p></div>` : `
    <div class="contacts-table-wrap">
      <table class="contacts-table">
        <thead><tr><th>Name</th><th>Telefon</th><th>Status</th><th>Thema</th><th></th></tr></thead>
        <tbody>
          ${recent.map(c => `
            <tr>
              <td><div class="contact-name">${c.vorname} ${c.nachname}</div><div class="contact-sub">${c.ort || ''}</div></td>
              <td><a class="call-btn" href="tel:${c.telefon}"><i class="ti ti-phone"></i>${c.telefon || '—'}</a></td>
              <td>${statusBadge(c.status)}</td>
              <td style="color:var(--text2);font-size:13px;">${c.thema || '—'}</td>
              <td><button class="btn-icon" onclick="showContact('${c.id}')"><i class="ti ti-eye"></i></button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`}

    <div style="margin-top:24px;display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <h2 style="font-size:15px;font-weight:600;">Anrufe diese Woche</h2>
      <button class="btn-ghost" style="font-size:13px;padding:6px 12px;" onclick="navigate('calendar')">Wochenplan öffnen</button>
    </div>
    ${renderCalendarMini()}

    <!-- ── GESCHÄFTLICHE TERMINANFRAGEN ──────────────────────── -->
    <div style="margin-top:32px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <h2 style="font-size:15px;font-weight:600;">Terminanfragen (Mandanten)</h2>
          ${businessInboxCount() > 0 ? `<span style="background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.4);color:var(--purple);border-radius:20px;padding:2px 9px;font-size:11px;font-weight:700;">${businessInboxCount()} offen</span>` : ''}
        </div>
      </div>
      <div id="businessInboxContainer">${renderBusinessInboxHTML()}</div>
    </div>

    <!-- ── MITARBEITER TERMINANFRAGEN ─────────────────────────── -->
    <div style="margin-top:28px;padding-top:24px;border-top:1px solid var(--border);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <h2 style="font-size:15px;font-weight:600;">👥 Terminanfragen (Mitarbeiter)</h2>
          ${staffInboxCount() > 0 ? `<span style="background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.4);color:#8b5cf6;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:700;">${staffInboxCount()} offen</span>` : ''}
        </div>
      </div>
      <div id="staffInboxContainer">${renderStaffInboxHTML()}</div>
    </div>

    <!-- ── PRIVATE TERMINANFRAGEN ──────────────────────────── -->
    <div style="margin-top:28px;padding-top:24px;border-top:1px solid var(--border);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <h2 style="font-size:15px;font-weight:600;">Private Terminanfragen</h2>
          ${privateInboxCount() > 0 ? `<span style="background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);color:var(--amber);border-radius:20px;padding:2px 9px;font-size:11px;font-weight:700;">${privateInboxCount()} offen</span>` : ''}
        </div>
      </div>
      <div id="privateInboxContainer">${renderPrivateInboxHTML()}</div>
    </div>
  `;
}

function privateInboxCount() {
  return privateSlots.filter(s => s.status === 'anfrage' || s.type === 'anfrage').length;
}

// ============================================================
// GESCHÄFTLICHE TERMINANFRAGEN – Inbox (booking.html → callSlots ohne privateBooking)
// ============================================================
function businessInboxCount() {
  // callSlots enthält NUR nicht-private Slots (strikte Trennung in loadCallSlots)
  // Mitarbeiter-Anfragen werden separat gezählt
  return callSlots.filter(s => (s.status === 'anfrage' || s.type === 'anfrage') && !s.isStaff).length;
}

function staffInboxCount() {
  return callSlots.filter(s => (s.status === 'anfrage' || s.type === 'anfrage') && s.isStaff === true).length;
}

function renderStaffInboxHTML() {
  const pending = callSlots
    .filter(s => (s.status === 'anfrage' || s.type === 'anfrage') && s.isStaff === true)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  if (pending.length === 0) {
    return `<div style="padding:16px;background:rgba(139,92,246,0.04);border:1px solid rgba(139,92,246,0.15);
      border-radius:12px;text-align:center;color:var(--text3);font-size:13px;">
      <i class="ti ti-users" style="font-size:18px;display:block;margin-bottom:6px;color:rgba(139,92,246,0.4);"></i>
      Keine offenen Mitarbeiter-Anfragen
    </div>`;
  }

  return pending.map(slot => {
    const dt    = new Date(slot.datetime);
    const dtEnd = new Date(dt.getTime() + (slot.apptDuration || 60) * 60000);
    const datum = dt.toLocaleDateString('de-DE', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
    const von   = dt.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    const bis   = dtEnd.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    const durLabel = `${slot.apptDuration || 60} Min`;

    return `
    <div style="background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.3);
      border-radius:12px;padding:14px 16px;margin-bottom:10px;
      border-left:4px solid #8b5cf6;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--text);">
            👥 ${slot.vorname || ''} ${slot.nachname || ''}
          </div>
          <div style="font-size:12px;color:var(--text3);margin-top:3px;">
            <i class="ti ti-users" style="font-size:11px;color:#8b5cf6;"></i>
            Mitarbeiter-Termin · ${slot.apptType || 'Terminart unbekannt'}
          </div>
        </div>
        <span style="background:rgba(139,92,246,0.15);color:#8b5cf6;border-radius:8px;
          padding:3px 9px;font-size:11px;font-weight:600;white-space:nowrap;">
          ⏳ Anfrage
        </span>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--text2);margin-bottom:10px;">
        <span><i class="ti ti-calendar-event" style="font-size:12px;margin-right:4px;color:#8b5cf6;"></i>${datum}</span>
        <span><i class="ti ti-clock" style="font-size:12px;margin-right:4px;color:#8b5cf6;"></i>${von} – ${bis} Uhr (${durLabel})</span>
        ${slot.email ? `<span><i class="ti ti-mail" style="font-size:12px;margin-right:4px;"></i>${slot.email}</span>` : ''}
        ${slot.telefon ? `<span><i class="ti ti-phone" style="font-size:12px;margin-right:4px;"></i>${slot.telefon}</span>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button onclick="confirmBusinessSlot('${slot.id}')"
          style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
          border-radius:8px;border:none;background:rgba(16,185,129,0.15);color:#10b981;
          font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;"
          onmouseover="this.style.background='rgba(16,185,129,0.25)'" onmouseout="this.style.background='rgba(16,185,129,0.15)'">
          <i class="ti ti-check"></i> Bestätigen
        </button>
        <button onclick="offerStaffAlternatives('${slot.id}')"
          style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
          border-radius:8px;border:1px solid rgba(139,92,246,0.4);background:transparent;color:#8b5cf6;
          font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;"
          onmouseover="this.style.background='rgba(139,92,246,0.1)'" onmouseout="this.style.background='transparent'">
          <i class="ti ti-calendar-search"></i> Alternativtermin anbieten
        </button>
        <button onclick="deleteBusinessSlot('${slot.id}')"
          style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
          border-radius:8px;border:1px solid rgba(239,68,68,0.3);background:transparent;color:var(--red);
          font-size:13px;cursor:pointer;font-family:inherit;transition:all .15s;"
          onmouseover="this.style.background='rgba(239,68,68,0.1)'" onmouseout="this.style.background='transparent'">
          <i class="ti ti-x"></i> Ablehnen
        </button>
      </div>
    </div>`;
  }).join('');
}

function renderBusinessInboxHTML() {
  const pending = callSlots
    .filter(s => (s.status === 'anfrage' || s.type === 'anfrage') && !s.isStaff)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  if (pending.length === 0) {
    return `<div style="padding:20px 16px;background:rgba(99,102,241,0.04);border:1px solid rgba(99,102,241,0.15);
      border-radius:12px;text-align:center;color:var(--text3);font-size:13px;">
      <i class="ti ti-calendar-check" style="font-size:20px;display:block;margin-bottom:6px;color:rgba(99,102,241,0.4);"></i>
      Keine offenen Mandanten-Anfragen
    </div>`;
  }

  return pending.map(slot => {
    const dt    = new Date(slot.datetime);
    const dtEnd = new Date(dt.getTime() + (slot.apptDuration || 60) * 60000);
    const datum = dt.toLocaleDateString('de-DE', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
    const von   = dt.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    const bis   = dtEnd.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    const durH  = Math.floor((slot.apptDuration || 60) / 60);
    const durM  = (slot.apptDuration || 60) % 60;
    const durLabel = durH > 0 ? (durM > 0 ? `${durH} Std ${durM} Min` : `${durH} Std`) : `${slot.apptDuration || 60} Min`;

    return `
    <div style="background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.2);
      border-radius:12px;padding:16px 18px;margin-bottom:10px;
      border-left:4px solid var(--purple);">

      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--text);">
            ${slot.vorname || ''} ${slot.nachname || ''}
          </div>
          <div style="font-size:12px;color:var(--text3);margin-top:3px;">
            <i class="ti ti-briefcase" style="font-size:11px;color:var(--purple);"></i>
            Mandant · ${slot.apptType || slot.thema || 'Terminart unbekannt'}
          </div>
        </div>
        <span style="background:rgba(99,102,241,0.15);color:var(--purple);border-radius:8px;
          padding:3px 9px;font-size:11px;font-weight:600;white-space:nowrap;">
          ⏳ Anfrage
        </span>
      </div>

      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--text2);margin-bottom:12px;">
        <span><i class="ti ti-calendar-event" style="font-size:12px;margin-right:4px;color:var(--purple);"></i>${datum}</span>
        <span><i class="ti ti-clock" style="font-size:12px;margin-right:4px;color:var(--purple);"></i>${von} – ${bis} Uhr (${durLabel})</span>
        ${slot.telefon ? `<span><i class="ti ti-phone" style="font-size:12px;margin-right:4px;"></i>${slot.telefon}</span>` : ''}
        ${slot.email ? `<span><i class="ti ti-mail" style="font-size:12px;margin-right:4px;"></i>${slot.email}</span>` : ''}
        ${slot.notizen ? `<span style="color:var(--text3);font-style:italic;">${slot.notizen}</span>` : ''}
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="confirmBusinessSlot('${slot.id}')"
          style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
          border-radius:8px;border:none;background:rgba(16,185,129,0.15);color:#10b981;
          font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;"
          onmouseover="this.style.background='rgba(16,185,129,0.25)'" onmouseout="this.style.background='rgba(16,185,129,0.15)'">
          <i class="ti ti-check"></i> Bestätigen
        </button>
        <button onclick="offerBusinessAlternatives('${slot.id}')"
          style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
          border-radius:8px;border:1px solid rgba(99,102,241,0.4);background:transparent;color:var(--purple);
          font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;"
          onmouseover="this.style.background='rgba(99,102,241,0.1)'" onmouseout="this.style.background='transparent'">
          <i class="ti ti-calendar-search"></i> Alternativtermine anbieten
        </button>
        <button onclick="deleteBusinessSlot('${slot.id}')"
          style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
          border-radius:8px;border:1px solid rgba(239,68,68,0.3);background:transparent;color:var(--red);
          font-size:13px;cursor:pointer;font-family:inherit;transition:all .15s;"
          onmouseover="this.style.background='rgba(239,68,68,0.1)'" onmouseout="this.style.background='transparent'">
          <i class="ti ti-x"></i> Ablehnen
        </button>
      </div>
    </div>`;
  }).join('');
}

function renderPrivateInboxHTML() {
  const pending = privateSlots
    .filter(s => s.status === 'anfrage' || s.type === 'anfrage')
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  if (pending.length === 0) {
    return `<div style="padding:20px 16px;background:rgba(245,158,11,0.04);border:1px solid rgba(245,158,11,0.15);
      border-radius:12px;text-align:center;color:var(--text3);font-size:13px;">
      <i class="ti ti-lock" style="font-size:20px;display:block;margin-bottom:6px;color:rgba(245,158,11,0.4);"></i>
      Keine offenen privaten Anfragen
    </div>`;
  }

  return pending.map(slot => {
    const dt = new Date(slot.datetime);
    const dtEnd = new Date(dt.getTime() + (slot.apptDuration || 60) * 60000);
    const datum = dt.toLocaleDateString('de-DE', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
    const von   = dt.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    const bis   = dtEnd.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    const durH  = Math.floor((slot.apptDuration||60) / 60);
    const durM  = (slot.apptDuration||60) % 60;
    const durLabel = durH > 0 ? (durM > 0 ? `${durH} Std ${durM} Min` : `${durH} Std`) : `${slot.apptDuration||60} Min`;

    return `
    <div style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);
      border-radius:12px;padding:16px 18px;margin-bottom:10px;
      border-left:4px solid var(--amber);">

      <!-- Header row -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--text);">
            ${slot.vorname || ''} ${slot.nachname || ''}
          </div>
          <div style="font-size:12px;color:var(--text3);margin-top:3px;">
            <i class="ti ti-lock" style="font-size:11px;color:var(--amber);"></i>
            Privater Termin · ${slot.apptType || slot.thema || 'Aktivität unbekannt'}
          </div>
        </div>
        <span style="background:rgba(245,158,11,0.15);color:var(--amber);border-radius:8px;
          padding:3px 9px;font-size:11px;font-weight:600;white-space:nowrap;">
          ⏳ Anfrage
        </span>
      </div>

      <!-- Date / time / duration info -->
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--text2);margin-bottom:12px;">
        <span><i class="ti ti-calendar-event" style="font-size:12px;margin-right:4px;color:var(--amber);"></i>${datum}</span>
        <span><i class="ti ti-clock" style="font-size:12px;margin-right:4px;color:var(--amber);"></i>${von} – ${bis} Uhr (${durLabel})</span>
        ${slot.telefon ? `<span><i class="ti ti-phone" style="font-size:12px;margin-right:4px;"></i>${slot.telefon}</span>` : ''}
        ${slot.notizen ? `<span style="color:var(--text3);font-style:italic;">${slot.notizen}</span>` : ''}
      </div>

      <!-- Action buttons -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="confirmPrivateSlot('${slot.id}')"
          style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
          border-radius:8px;border:none;background:rgba(16,185,129,0.15);color:#10b981;
          font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;"
          onmouseover="this.style.background='rgba(16,185,129,0.25)'" onmouseout="this.style.background='rgba(16,185,129,0.15)'">
          <i class="ti ti-check"></i> Bestätigen
        </button>
        <button onclick="offerPrivateAlternatives('${slot.id}')"
          style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
          border-radius:8px;border:1px solid rgba(245,158,11,0.4);background:transparent;color:var(--amber);
          font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;"
          onmouseover="this.style.background='rgba(245,158,11,0.1)'" onmouseout="this.style.background='transparent'">
          <i class="ti ti-calendar-search"></i> Alternativen anbieten
        </button>
        <button onclick="deletePrivateSlot('${slot.id}')"
          style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
          border-radius:8px;border:1px solid rgba(239,68,68,0.3);background:transparent;color:var(--red);
          font-size:13px;cursor:pointer;font-family:inherit;transition:all .15s;"
          onmouseover="this.style.background='rgba(239,68,68,0.1)'" onmouseout="this.style.background='transparent'">
          <i class="ti ti-x"></i> Ablehnen
        </button>
      </div>
    </div>`;
  }).join('');
}

function renderCalendarMini() {
  const today = new Date();
  const weekSlots = callSlots.filter(s => {
    const d = new Date(s.datetime);
    const diff = (d - today) / 86400000;
    return diff >= -1 && diff <= 7;
  }).slice(0, 4);

  if (weekSlots.length === 0) return `<p style="color:var(--text3);font-size:14px;">Keine Anrufe geplant. <button class="btn-ghost" style="font-size:13px;padding:4px 10px;" onclick="navigate('calendar')">Einplanen</button></p>`;
  return `<div style="display:flex;flex-direction:column;gap:8px;">${weekSlots.map(s => {
    const contact = contacts.find(c => c.id === s.contactId);
    const name = contact ? `${contact.vorname} ${contact.nachname}` : 'Unbekannt';
    return `<div class="call-slot ${s.type === 'flex' ? 'flex' : ''}" style="display:flex;gap:10px;align-items:center;">
      <i class="ti ti-phone" style="font-size:14px;"></i>
      <span style="flex:1;font-weight:500;">${name}</span>
      <span style="font-size:11px;opacity:0.7;">${fmtDate(s.datetime)}</span>
      ${s.type === 'flex' ? '<span style="font-size:10px;opacity:0.6;">[Flexibel]</span>' : ''}
    </div>`;
  }).join('')}</div>`;
}

// ============================================================
// CONTACTS PAGE
// ============================================================
function renderContacts(filter = '', statusFilter = '', catFilter = '') {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const labels = {
    mandant:            s.catLabelMandant            || 'Mandant',
    privat:             s.catLabelPrivat             || 'Privat',
    mitarbeiter:        s.catLabelMitarbeiter        || 'Mitarbeiter',
    mandantMitarbeiter: s.catLabelMandantMitarbeiter || 'Mandant von Mitarbeiter',
  };
  const catColors = {
    mandant:            '#6366f1',
    privat:             '#f59e0b',
    mitarbeiter:        '#8b5cf6',
    mandantMitarbeiter: '#10b981',
  };
  const catIcons = {
    mandant:            'ti-briefcase',
    privat:             'ti-heart',
    mitarbeiter:        'ti-users',
    mandantMitarbeiter: 'ti-user-plus',
  };

  const filtered = contacts.filter(c => {
    const catLabel = c.contactCategory ? (labels[c.contactCategory] || c.contactCategory) : '';
    const search = `${c.vorname} ${c.nachname} ${c.telefon} ${c.email} ${c.ort} ${c.thema} ${c.quelle || ''} ${catLabel}`.toLowerCase();
    const matchSearch = !filter || search.includes(filter.toLowerCase());
    const matchStatus = !statusFilter || c.status === statusFilter;
    const matchCat    = !catFilter   || c.contactCategory === catFilter;
    return matchSearch && matchStatus && matchCat;
  });

  const catCounts = {
    mandant:            contacts.filter(c => c.contactCategory === 'mandant').length,
    privat:             contacts.filter(c => c.contactCategory === 'privat').length,
    mitarbeiter:        contacts.filter(c => c.contactCategory === 'mitarbeiter').length,
    mandantMitarbeiter: contacts.filter(c => c.contactCategory === 'mandantMitarbeiter').length,
  };

  function tabStyle(key) {
    const active = catFilter === key;
    const col = catColors[key];
    return `font-size:13px;padding:6px 14px;border-radius:20px;cursor:pointer;transition:all .15s;` +
      `border:1.5px solid ${active ? col : 'var(--border2)'};` +
      `background:${active ? col + '22' : 'transparent'};` +
      `color:${active ? col : 'var(--text2)'};` +
      `font-weight:${active ? '600' : '400'};`;
  }

  function catBadge(category) {
    if (!category) return '';
    const col  = catColors[category];
    const icon = catIcons[category];
    const lbl  = labels[category];
    if (!col) return '';
    return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;` +
      `border-radius:4px;padding:1px 6px;background:${col}22;color:${col};border:1px solid ${col}55;">` +
      `<i class="ti ${icon}" style="font-size:11px;"></i>${lbl}</span>`;
  }

  document.getElementById('content').innerHTML = `
    <div class="contacts-header">
      <div class="search-box">
        <i class="ti ti-search"></i>
        <input type="text" id="searchInput" placeholder="Suchen nach Name, Telefon, E-Mail, Quelle, Kategorie..." value="${filter}" />
      </div>
      <select class="filter-select" id="statusFilter">
        <option value="">Alle Status</option>
        ${[...new Set(contacts.map(c => c.status).filter(Boolean))].map(st => `<option value="${st}" ${statusFilter===st?'selected':''}>${st}</option>`).join('')}
      </select>
      <button class="btn-primary" onclick="openContactModal()"><i class="ti ti-plus"></i> Neu</button>
    </div>

    <!-- Kategorie-Filter Tabs -->
    <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;align-items:center;">
      <button onclick="renderContacts(document.getElementById('searchInput')?.value||'',document.getElementById('statusFilter')?.value||'','')"
        style="font-size:13px;padding:6px 14px;border-radius:20px;cursor:pointer;transition:all .15s;
        border:1.5px solid ${!catFilter?'var(--accent)':'var(--border2)'};
        background:${!catFilter?'rgba(59,130,246,0.12)':'transparent'};
        color:${!catFilter?'var(--accent)':'var(--text2)'};
        font-weight:${!catFilter?'600':'400'};">
        Alle <span style="font-size:11px;opacity:.7;">(${contacts.length})</span>
      </button>
      ${Object.entries(labels).map(([key, lbl]) => `
        <button onclick="renderContacts(document.getElementById('searchInput')?.value||'',document.getElementById('statusFilter')?.value||'','${key}')"
          style="${tabStyle(key)}">
          <i class="ti ${catIcons[key]}" style="font-size:12px;"></i> ${lbl}
          <span style="font-size:11px;opacity:.7;">(${catCounts[key]})</span>
        </button>
      `).join('')}
      ${catFilter ? `
        <button onclick="renderContacts(document.getElementById('searchInput')?.value||'',document.getElementById('statusFilter')?.value||'','')"
          style="font-size:11px;padding:4px 10px;border-radius:20px;border:1px solid var(--border2);background:transparent;color:var(--text3);cursor:pointer;">
          <i class="ti ti-x"></i> Aufheben
        </button>` : ''}
    </div>

    ${filtered.length === 0
      ? `<div class="empty-state"><i class="ti ti-user-off"></i><p>Keine Kontakte gefunden.</p></div>`
      : `<div class="contacts-table-wrap">
          <table class="contacts-table">
            <thead><tr><th>Name</th><th>Telefon</th><th>E-Mail</th><th>Thema</th><th>Status</th><th>Kategorie</th><th></th></tr></thead>
            <tbody>
              ${filtered.map(c => `
              <tr>
                <td>
                  <div class="contact-name">${c.vorname} ${c.nachname}</div>
                  <div class="contact-sub">${c.ort || ''}</div>
                </td>
                <td><a class="call-btn" href="tel:${c.telefon}"><i class="ti ti-phone"></i>${c.telefon || '—'}</a></td>
                <td style="font-size:13px;color:var(--text2);">${c.email || '—'}</td>
                <td style="font-size:13px;color:var(--text2);">${c.thema || '—'}</td>
                <td>${statusBadge(c.status)}</td>
                <td>${catBadge(c.contactCategory)}</td>
                <td style="display:flex;gap:6px;">
                  <button class="btn-icon" onclick="showContact('${c.id}')"><i class="ti ti-eye"></i></button>
                  <button class="btn-icon" onclick="openContactModal('${c.id}')"><i class="ti ti-edit"></i></button>
                  <button class="btn-icon danger" onclick="deleteContact('${c.id}')"><i class="ti ti-trash"></i></button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`}
  `;

  document.getElementById('searchInput').addEventListener('input', e => renderContacts(e.target.value, document.getElementById('statusFilter').value, catFilter));
  document.getElementById('statusFilter').addEventListener('change', e => renderContacts(document.getElementById('searchInput').value, e.target.value, catFilter));
}

window.renderContacts = renderContacts;

// ============================================================
// CONTACT DETAIL
// ============================================================
window.showContact = function(id) {
  currentContactId = id;
  const c = contacts.find(x => x.id === id);
  if (!c) return;

  const history = (c.history || []).sort((a,b) => new Date(b.datetime) - new Date(a.datetime));

  document.getElementById('content').innerHTML = `
    <button class="back-btn" onclick="navigate('contacts')"><i class="ti ti-arrow-left"></i> Zurück</button>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
      <div>
        <h2 style="font-size:20px;font-weight:600;">${c.vorname} ${c.nachname}</h2>
        <div style="margin-top:4px;">${statusBadge(c.status)}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a class="call-btn" href="tel:${c.telefon}"><i class="ti ti-phone"></i> Anrufen</a>
        <button class="btn-ghost" onclick="addHistoryEntry('${c.id}')"><i class="ti ti-history"></i> Eintrag</button>
        <button class="btn-ghost" onclick="openContactModal('${c.id}')"><i class="ti ti-edit"></i> Bearbeiten</button>
        <button class="btn-ghost" onclick="openScheduleForContactModal('${c.id}')"><i class="ti ti-calendar-plus"></i> Einplanen</button>
        <button class="btn-ghost" onclick="generateBookingLink('${c.id}')" style="color:var(--purple);border-color:rgba(167,139,250,0.4);">
          <i class="ti ti-link"></i> Buchungslink
        </button>
        <button class="btn-ghost" onclick="generatePrivateBookingLinkForContact('${c.id}')" style="color:var(--amber);border-color:rgba(245,158,11,0.4);">
          <i class="ti ti-lock"></i> Privat-Link
        </button>
      </div>
    </div>

    <div class="contact-detail">
      <div>
        <div class="detail-card" style="margin-bottom:16px;">
          <h3>Kontaktdaten</h3>
          <div class="detail-row"><span class="detail-key">Telefon</span><span class="detail-val"><a href="tel:${c.telefon}">${c.telefon || '—'}</a></span></div>
          <div class="detail-row"><span class="detail-key">E-Mail</span><span class="detail-val"><a href="mailto:${c.email}">${c.email || '—'}</a></span></div>
          <div class="detail-row"><span class="detail-key">Ort</span><span class="detail-val">${c.ort || '—'}</span></div>
          <div class="detail-row"><span class="detail-key">Thema</span><span class="detail-val">${c.thema || '—'}</span></div>
          <div class="detail-row"><span class="detail-key">Quelle</span><span class="detail-val">${c.quelle || '—'}</span></div>
          ${c.absagegrund ? `<div class="detail-row"><span class="detail-key">Absagegrund</span><span class="detail-val" style="color:var(--red)">${c.absagegrund}</span></div>` : ''}
          ${c.wiedervorlage ? `<div class="detail-row"><span class="detail-key" style="color:var(--purple);">📅 Wiedervorlage</span><span class="detail-val" style="color:var(--purple);font-weight:500;">${fmtDate(c.wiedervorlage)}${c.wvType ? ` · ${c.wvType}` : ''}${c.wvNote ? ` – ${c.wvNote}` : ''}</span></div>` : ''}
        </div>
        ${c.notizen ? `<div class="detail-card">
          <h3>Notizen</h3>
          <p style="font-size:14px;color:var(--text2);line-height:1.6;">${c.notizen}</p>
        </div>` : ''}
      </div>

      <div>
        <div class="detail-card">
          <h3 style="display:flex;align-items:center;justify-content:space-between;">
            Kontaktverlauf
            <button class="btn-icon" onclick="addHistoryEntry('${c.id}')"><i class="ti ti-plus"></i></button>
          </h3>
          ${history.length === 0 ? `<p style="color:var(--text3);font-size:14px;">Noch kein Verlauf.</p>` : `
          <div class="history-list">
            ${history.map(h => `
              <div class="history-item type-${h.type}">
                <div class="history-meta">
                  <span class="history-type">${h.type === 'anruf' ? '📞' : h.type === 'email' ? '📧' : h.type === 'termin' ? '📅' : h.type === 'whatsapp' ? '💬' : '📝'} ${h.type.charAt(0).toUpperCase()+h.type.slice(1)}</span>
                  <span class="history-date">${fmtDate(h.datetime)}</span>
                </div>
                <div class="history-note">${h.note || ''}</div>
                ${h.followup ? `<div class="history-followup"><i class="ti ti-calendar-event"></i> Folgetermin: ${fmtDate(h.followup)}</div>` : ''}
              </div>
            `).join('')}
          </div>`}
        </div>
      </div>
    </div>
  `;
};

// ============================================================
// TERMIN EINPLANEN – direkt aus Kontakt heraus
// ============================================================
window.openScheduleForContactModal = function(contactId) {
  const contact = contacts.find(c => c.id === contactId);
  if (!contact) return;

  document.getElementById('scheduleForContactModal')?.remove();

  const cfg         = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const dayConfigs  = cfg.dayConfigs  || {};
  const blockedDates = cfg.blockedDates || [];
  const months   = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const dayNames = ['Mo','Di','Mi','Do','Fr','Sa','So'];
  const pad = n => String(n).padStart(2,'0');
  const today = new Date(); today.setHours(0,0,0,0);

  let calYear  = today.getFullYear();
  let calMonth = today.getMonth();
  let pickedDate = null;
  let pickedTime = null;

  function getDayConfig(jsDay) {
    return dayConfigs[String(jsDay)] || dayConfigs[jsDay] || null;
  }

  function getDuration() {
    const v = parseInt(document.getElementById('sfc_duration')?.value || '60', 10);
    return (isNaN(v) || v < 5) ? 60 : v;
  }

  function isDateAvail(date) {
    if (date < today) return false;
    const dc = getDayConfig(date.getDay());
    if (!dc || !dc.enabled) return false;
    const ds = date.getFullYear() + '-' + pad(date.getMonth()+1) + '-' + pad(date.getDate());
    if (blockedDates.includes(ds)) return false;
    // Check if day has at least one free slot with current duration
    return getTimeSlotsForDate(date, 60).some(s => s.free);
  }

  function getTimeSlotsForDate(date, dur) {
    const dc = getDayConfig(date.getDay());
    if (!dc) return [];
    const [sh,sm] = dc.start.split(':').map(Number);
    const [eh,em] = dc.end.split(':').map(Number);
    const dayStart = sh*60+sm, dayEnd = eh*60+em;
    let brkS = Infinity, brkE = -Infinity;
    if (dc.breakStart && dc.breakEnd) {
      const [bsh,bsm] = dc.breakStart.split(':').map(Number);
      const [beh,bem] = dc.breakEnd.split(':').map(Number);
      brkS = bsh*60+bsm; brkE = beh*60+bem;
    }
    const taken = _csBuildTakenList();
    const now = new Date();
    const slots = [];
    for (let t = dayStart; t + dur <= dayEnd; t += 30) {
      if (brkS !== Infinity && t < brkE && (t + dur) > brkS) continue;
      const slotDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(t/60), t%60);
      if (slotDate <= now) continue;
      const slotEnd = new Date(slotDate.getTime() + dur * 60000);
      const free = !taken.some(tk => slotDate < tk.end && slotEnd > tk.start);
      slots.push({ time: pad(Math.floor(t/60)) + ':' + pad(t%60), free, date: slotDate });
    }
    return slots;
  }

  function buildCalCells() {
    const dur = getDuration();
    const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
    const firstDow    = new Date(calYear, calMonth, 1).getDay();
    const blanks      = firstDow === 0 ? 6 : firstDow - 1;
    let cells = dayNames.map(d => `<div style="text-align:center;font-size:11px;color:var(--text3);font-weight:600;padding:4px 0;">${d}</div>`).join('');
    for (let b = 0; b < blanks; b++) cells += `<div></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const date  = new Date(calYear, calMonth, d);
      const isPast = date < today;
      const dc    = getDayConfig(date.getDay());
      const avail = !isPast && dc && dc.enabled && !blockedDates.includes(`${calYear}-${pad(calMonth+1)}-${pad(d)}`);
      const hasFree = avail && getTimeSlotsForDate(date, dur).some(s => s.free);
      const isSel  = pickedDate && pickedDate.getFullYear()===calYear && pickedDate.getMonth()===calMonth && pickedDate.getDate()===d;
      let style = 'aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:13px;font-weight:500;cursor:default;';
      if (isPast || !avail || !hasFree) style += 'color:var(--text3);opacity:.35;';
      else if (isSel)                   style += 'background:#6366f1;color:#fff;font-weight:700;cursor:pointer;';
      else                              style += 'background:rgba(99,102,241,0.12);color:var(--text);cursor:pointer;border:1px solid rgba(99,102,241,0.3);';
      const onclick = hasFree ? `onclick="window._sfcPickDay(${calYear},${calMonth},${d})"` : '';
      cells += `<div style="${style}" ${onclick}>${d}</div>`;
    }
    return cells;
  }

  function buildTimeGrid() {
    if (!pickedDate) return '';
    const dur = getDuration();
    const slots = getTimeSlotsForDate(pickedDate, dur);
    if (slots.length === 0) return `<p style="color:var(--text3);font-size:13px;margin-top:12px;">Keine freien Zeiten an diesem Tag für ${dur} Min.</p>`;
    const dateLabel = pickedDate.toLocaleDateString('de-DE', {weekday:'long', day:'2-digit', month:'long'});
    return `
      <div style="margin-top:14px;">
        <div style="font-size:12px;font-weight:600;color:var(--text3);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em;">
          Zeiten – ${dateLabel}
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;">
          ${slots.map(sl => {
            const isSel = pickedTime === sl.time;
            let s = 'padding:9px 4px;text-align:center;border-radius:8px;font-size:13px;font-weight:500;transition:all .1s;';
            if (!sl.free)   s += 'background:rgba(255,255,255,0.03);color:var(--text3);opacity:.45;cursor:default;';
            else if (isSel) s += 'background:#6366f1;color:#fff;cursor:pointer;';
            else            s += 'background:rgba(99,102,241,0.1);color:var(--text);cursor:pointer;border:1px solid rgba(99,102,241,0.25);';
            const oc = sl.free ? `onclick="window._sfcPickTime('${sl.time}')"` : '';
            return `<div style="${s}" ${oc}>${sl.time}</div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function buildSaveBtn() {
    const name = document.getElementById('sfc_name')?.value.trim();
    const dur  = getDuration();
    const canSave = pickedDate && pickedTime && name;
    const style = `width:100%;padding:11px;border-radius:10px;border:none;font-size:14px;font-weight:700;
      font-family:inherit;cursor:${canSave?'pointer':'default'};transition:all .15s;
      background:${canSave?'#6366f1':'rgba(255,255,255,0.07)'};
      color:${canSave?'#fff':'var(--text3)'};opacity:${canSave?'1':'.5'};`;
    return `<button id="sfcSaveBtn" style="${style}" ${canSave?'onclick="window._sfcSave()"':''}>
      <i class="ti ti-calendar-check"></i> Termin speichern
    </button>`;
  }

  function render() {
    const nameVal = document.getElementById('sfc_name')?.value || '';
    const durVal  = document.getElementById('sfc_duration')?.value || '60';
    dlg.querySelector('.sfc-inner').innerHTML = buildInner(nameVal, durVal);
    rebind();
  }

  function buildInner(nameVal = '', durVal = '60') {
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
        <h2 style="font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px;">
          <i class="ti ti-calendar-plus" style="color:#6366f1;"></i>
          Termin einplanen
        </h2>
        <button onclick="document.getElementById('scheduleForContactModal').remove()"
          style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:20px;"><i class="ti ti-x"></i></button>
      </div>

      <!-- Kontakt -->
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;
        background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);margin-bottom:16px;">
        <div style="width:34px;height:34px;border-radius:50%;background:#6366f1;display:flex;align-items:center;justify-content:center;
          font-size:14px;font-weight:700;color:#fff;flex-shrink:0;">
          ${(contact.vorname?.[0]||'?').toUpperCase()}
        </div>
        <div>
          <div style="font-weight:600;font-size:14px;">${contact.vorname} ${contact.nachname}</div>
          ${contact.telefon ? `<div style="font-size:12px;color:var(--text3);">${contact.telefon}</div>` : ''}
        </div>
      </div>

      <!-- Terminname & Dauer -->
      <div style="display:grid;grid-template-columns:1fr 120px;gap:10px;margin-bottom:16px;">
        <div>
          <label style="font-size:12px;color:var(--text3);display:block;margin-bottom:5px;font-weight:600;">
            <i class="ti ti-tag" style="font-size:11px;"></i> Terminname
          </label>
          <input id="sfc_name" type="text" value="${nameVal}"
            placeholder="z.B. Erstgespräch, Beratung..."
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);
            border-radius:8px;padding:9px 12px;font-size:13px;font-family:inherit;box-sizing:border-box;"
            oninput="window._sfcRefreshBtn()" />
        </div>
        <div>
          <label style="font-size:12px;color:var(--text3);display:block;margin-bottom:5px;font-weight:600;">
            <i class="ti ti-clock" style="font-size:11px;"></i> Dauer (Min.)
          </label>
          <input id="sfc_duration" type="number" value="${durVal}" min="5" step="5"
            placeholder="60"
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);
            border-radius:8px;padding:9px 12px;font-size:13px;font-family:inherit;box-sizing:border-box;"
            oninput="window._sfcDurChanged()" />
        </div>
      </div>

      <!-- Kalender -->
      <div style="font-size:12px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">
        Datum wählen
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <button onclick="window._sfcCalPrev()" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:5px 12px;cursor:pointer;font-size:15px;">‹</button>
        <span style="font-weight:600;font-size:14px;">${months[calMonth]} ${calYear}</span>
        <button onclick="window._sfcCalNext()" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:5px 12px;cursor:pointer;font-size:15px;">›</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:4px;">
        ${buildCalCells()}
      </div>

      <!-- Freie Zeiten -->
      ${buildTimeGrid()}

      <!-- Gewählte Zusammenfassung -->
      ${pickedDate && pickedTime ? `
      <div style="margin-top:14px;padding:10px 14px;border-radius:10px;background:rgba(99,102,241,0.1);
        border:1px solid rgba(99,102,241,0.25);font-size:13px;display:flex;align-items:center;gap:8px;">
        <i class="ti ti-calendar-event" style="color:#6366f1;font-size:16px;"></i>
        <span style="font-weight:500;">
          ${pickedDate.toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'short',year:'numeric'})}
          · ${pickedTime} Uhr · ${getDuration()} Min.
        </span>
      </div>` : ''}

      <!-- Speichern -->
      <div style="margin-top:16px;">
        ${buildSaveBtn()}
      </div>
    `;
  }

  function rebind() {
    // Focus-Erhalt für Inputs nach re-render
  }

  const dlg = document.createElement('div');
  dlg.id = 'scheduleForContactModal';
  dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:700;display:flex;align-items:center;justify-content:center;padding:16px;';
  dlg.innerHTML = `<div class="sfc-inner" style="background:var(--bg2);border:1px solid var(--border2);border-radius:18px;
    padding:24px 22px;width:100%;max-width:500px;max-height:92vh;overflow-y:auto;animation:modalIn .2s ease;"></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector('.sfc-inner').innerHTML = buildInner();

  // Global callbacks
  window._sfcPickDay = (y, m, d) => {
    pickedDate = new Date(y, m, d);
    pickedTime = null;
    dlg.querySelector('.sfc-inner').innerHTML = buildInner(
      document.getElementById('sfc_name')?.value || '',
      document.getElementById('sfc_duration')?.value || '60'
    );
  };
  window._sfcPickTime = (t) => {
    pickedTime = t;
    dlg.querySelector('.sfc-inner').innerHTML = buildInner(
      document.getElementById('sfc_name')?.value || '',
      document.getElementById('sfc_duration')?.value || '60'
    );
  };
  window._sfcCalPrev = () => {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
    dlg.querySelector('.sfc-inner').innerHTML = buildInner(
      document.getElementById('sfc_name')?.value || '',
      document.getElementById('sfc_duration')?.value || '60'
    );
  };
  window._sfcCalNext = () => {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
    dlg.querySelector('.sfc-inner').innerHTML = buildInner(
      document.getElementById('sfc_name')?.value || '',
      document.getElementById('sfc_duration')?.value || '60'
    );
  };
  window._sfcDurChanged = () => {
    pickedTime = null; // Zeiten neu berechnen
    dlg.querySelector('.sfc-inner').innerHTML = buildInner(
      document.getElementById('sfc_name')?.value || '',
      document.getElementById('sfc_duration')?.value || '60'
    );
  };
  window._sfcRefreshBtn = () => {
    const btn = document.getElementById('sfcSaveBtn');
    if (!btn) return;
    const name = document.getElementById('sfc_name')?.value.trim();
    const canSave = pickedDate && pickedTime && name;
    btn.style.background = canSave ? '#6366f1' : 'rgba(255,255,255,0.07)';
    btn.style.color = canSave ? '#fff' : 'var(--text3)';
    btn.style.opacity = canSave ? '1' : '.5';
    btn.style.cursor = canSave ? 'pointer' : 'default';
    btn.onclick = canSave ? window._sfcSave : null;
  };
  window._sfcSave = async () => {
    const name = document.getElementById('sfc_name')?.value.trim();
    const dur  = getDuration();
    if (!pickedDate || !pickedTime || !name) { toast('Bitte alle Felder ausfüllen.', 'error'); return; }

    const [h, m2] = pickedTime.split(':').map(Number);
    const iso = `${pickedDate.getFullYear()}-${pad(pickedDate.getMonth()+1)}-${pad(pickedDate.getDate())}T${pad(h)}:${pad(m2)}`;

    const slotData = {
      contactId:    contactId,
      vorname:      contact.vorname || '',
      nachname:     contact.nachname || '',
      telefon:      contact.telefon || '',
      email:        contact.email || '',
      apptType:     name,
      apptDuration: dur,
      datetime:     iso,
      status:       'fix',
      type:         'fix',
      createdAt:    new Date().toISOString(),
      note:         '',
    };

    try {
      await addDoc(collection(db, 'callSlots'), slotData);
      // Verlaufs-Eintrag beim Kontakt
      const kontakt = contacts.find(c => c.id === contactId);
      if (kontakt) {
        const histEntry = {
          id: Date.now().toString(),
          type: 'termin',
          datetime: new Date().toISOString(),
          note: `Termin eingetragen: ${name} · ${pickedDate.toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'short',year:'numeric'})} ${pickedTime} Uhr · ${dur} Min.`,
        };
        const updHistory = [...(kontakt.history || []), histEntry];
        await updateDoc(doc(db, 'contacts', contactId), { history: updHistory });
      }
      toast(`Termin „${name}" eingetragen! ✓`, 'success');
      dlg.remove();
      showContact(contactId);
    } catch(e) {
      console.error(e);
      toast('Fehler beim Speichern.', 'error');
    }
  };
};

// ============================================================
// CONTACT MODAL
// ── Custom mini-calendar picker for Wiedervorlage ──
let _wvPickerYear = null, _wvPickerMonth = null, _wvPickerDay = null;

function initWvPicker(existingIso) {
  const base = existingIso ? new Date(existingIso) : new Date();
  _wvPickerYear  = base.getFullYear();
  _wvPickerMonth = base.getMonth();
  _wvPickerDay   = existingIso ? base.getDate() : null;

  // ── Build day-header row (Mo–So) ──
  const dayHeadersEl = document.getElementById('wv_dayheaders');
  if (dayHeadersEl) {
    dayHeadersEl.innerHTML = ['Mo','Di','Mi','Do','Fr','Sa','So']
      .map(d => `<div style="text-align:center;font-size:10px;color:var(--text3);font-weight:600;padding:2px 0;">${d}</div>`)
      .join('');
  }

  // ── Build hour options (07–19) ──
  const hourSel = document.getElementById('wv_hour');
  if (hourSel && hourSel.options.length === 0) {
    Array.from({length:13}, (_,i) => i+7).forEach(h => {
      const o = document.createElement('option');
      o.value = h; o.textContent = String(h).padStart(2,'0');
      hourSel.appendChild(o);
    });
  }

  // ── Build minute options (00/15/30/45) ──
  const minSel = document.getElementById('wv_minute');
  if (minSel && minSel.options.length === 0) {
    ['00','15','30','45'].forEach(m => {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      minSel.appendChild(o);
    });
  }

  if (existingIso) {
    const h = base.getHours(), m = base.getMinutes();
    document.getElementById('wv_hour').value = h >= 7 && h <= 19 ? h : 9;
    // snap minute to nearest 15
    const snap = [0,15,30,45].reduce((a,b) => Math.abs(b-m)<Math.abs(a-m)?b:a, 0);
    document.getElementById('wv_minute').value = String(snap).padStart(2,'0');
  } else {
    document.getElementById('wv_hour').value = 9;
    document.getElementById('wv_minute').value = '00';
  }

  renderWvCalendar();

  // Month nav
  document.getElementById('wv_prevMonth').onclick = () => {
    _wvPickerMonth--; if (_wvPickerMonth < 0) { _wvPickerMonth = 11; _wvPickerYear--; }
    renderWvCalendar();
  };
  document.getElementById('wv_nextMonth').onclick = () => {
    _wvPickerMonth++; if (_wvPickerMonth > 11) { _wvPickerMonth = 0; _wvPickerYear++; }
    renderWvCalendar();
  };

  // Time change → update hidden input
  ['wv_hour','wv_minute'].forEach(id => document.getElementById(id).addEventListener('change', syncWvHidden));
}

function renderWvCalendar() {
  const months = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  document.getElementById('wv_monthLabel').textContent = `${months[_wvPickerMonth]} ${_wvPickerYear}`;

  const firstDow = new Date(_wvPickerYear, _wvPickerMonth, 1).getDay(); // 0=Sun
  const leadingBlanks = firstDow === 0 ? 6 : firstDow - 1; // Monday-first
  const daysInMonth = new Date(_wvPickerYear, _wvPickerMonth + 1, 0).getDate();
  const todayStr = new Date().toDateString();

  let cells = '';
  for (let b = 0; b < leadingBlanks; b++) cells += `<div></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const isSelected = _wvPickerDay === d;
    const isToday = new Date(_wvPickerYear, _wvPickerMonth, d).toDateString() === todayStr;
    const isPast = new Date(_wvPickerYear, _wvPickerMonth, d) < new Date(new Date().setHours(0,0,0,0));
    cells += `<div onclick="window._wvSelectDay(${d})" style="
      text-align:center;padding:5px 2px;border-radius:7px;font-size:13px;cursor:${isPast?'default':'pointer'};
      transition:all .12s;
      background:${isSelected?'var(--accent)':'transparent'};
      color:${isSelected?'#fff':isPast?'var(--text3)':isToday?'var(--accent)':'var(--text)'};
      font-weight:${isSelected||isToday?'600':'400'};
      outline:${isToday&&!isSelected?'1px solid var(--accent)':'none'};
      opacity:${isPast?'0.4':'1'};
    " onmouseover="if(!${isPast}&&!${isSelected})this.style.background='var(--bg2)'" onmouseout="this.style.background='${isSelected?'var(--accent)':'transparent'}'">${d}</div>`;
  }
  document.getElementById('wv_daygrid').innerHTML = cells;
}

window._wvSelectDay = function(d) {
  const isPast = new Date(_wvPickerYear, _wvPickerMonth, d) < new Date(new Date().setHours(0,0,0,0));
  if (isPast) return;
  _wvPickerDay = d;
  renderWvCalendar();
  syncWvHidden();
};

function syncWvHidden() {
  if (!_wvPickerDay) { document.getElementById('f_wiedervorlage').value = ''; document.getElementById('wv_selected_display').textContent = ''; return; }
  const h = document.getElementById('wv_hour').value;
  const m = document.getElementById('wv_minute').value;
  const pad = n => String(n).padStart(2,'0');
  const iso = `${_wvPickerYear}-${pad(_wvPickerMonth+1)}-${pad(_wvPickerDay)}T${pad(h)}:${m}`;
  document.getElementById('f_wiedervorlage').value = iso;
  const display = new Date(iso).toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'short',year:'numeric'});
  document.getElementById('wv_selected_display').textContent = `✓ ${display} ${pad(h)}:${m}`;
}

// ============================================================
window.openContactModal = function(id = null) {
  editingContactId = id;
  const c = id ? contacts.find(x => x.id === id) : null;
  document.getElementById('modalTitle').textContent = id ? 'Kontakt bearbeiten' : 'Kontakt anlegen';

  document.getElementById('f_vorname').value = c?.vorname || '';
  document.getElementById('f_nachname').value = c?.nachname || '';
  document.getElementById('f_telefon').value = c?.telefon || '';
  document.getElementById('f_email').value = c?.email || '';
  document.getElementById('f_ort').value = c?.ort || '';
  document.getElementById('f_thema').value = c?.thema || '';
  document.getElementById('f_quelle').value = c?.quelle || '';
  document.getElementById('f_status').value = c?.status || 'Neu';
  document.getElementById('f_absagegrund').value = c?.absagegrund || '';
  document.getElementById('f_notizen').value = c?.notizen || '';

  // ── Kategorie: nur Admin darf ändern ──
  const catSel = document.getElementById('f_category');
  if (catSel) {
    catSel.value = c?.contactCategory || '';
    const isAdmin = auth.currentUser?.email === ALLOWED_EMAIL;
    catSel.disabled = !isAdmin;
    const wrap = document.getElementById('f_category_wrap');
    if (wrap) {
      wrap.title = isAdmin ? '' : 'Nur der Administrator kann die Kategorie ändern.';
      wrap.style.opacity = isAdmin ? '1' : '0.5';
    }
    // Update option labels from settings
    const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
    const opts = catSel.querySelectorAll('option');
    if (opts[1]) opts[1].textContent = '📋 ' + (s.catLabelMandant || 'Mandant');
    if (opts[2]) opts[2].textContent = '🏠 ' + (s.catLabelPrivat || 'Privat');
    if (opts[3]) opts[3].textContent = '👥 ' + (s.catLabelMitarbeiter || 'Mitarbeiter');
    if (opts[4]) opts[4].textContent = '🤝 ' + (s.catLabelMandantMitarbeiter || 'Mandant von Mitarbeiter');
  }

  // ── Terminarten aus Einstellungen befüllen (nur die 4 konfigurierten Kategorien) ──
  const cfg = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const apptTypes = cfg.apptTypes || [];
  const typeSel = document.getElementById('f_wv_type');
  // Erste Option ist leer – Terminart wird freigelassen wenn unklar
  typeSel.innerHTML = `<option value="">— Terminart —</option>` +
    apptTypes.map(t =>
      `<option value="${t.name}" data-color="${t.color}" data-duration="${t.duration}" style="color:${t.color};">` +
      `${t.name} (${t.duration} Min.)</option>`
    ).join('');
  // Nur wenn eine gespeicherte Terminart vorhanden ist, wird sie wiederhergestellt
  if (c?.wvType && apptTypes.some(t => t.name === c.wvType)) typeSel.value = c.wvType;

  document.getElementById('f_wv_note').value = c?.wvNote || '';
  document.getElementById('f_wv_confirm').checked = c?.wvConfirm || false;
  document.getElementById('f_wv_reminder').checked = c?.wvReminder || false;

  // ── Custom picker init ──
  initWvPicker(c?.wiedervorlage || null);

  // ── Show/hide email options ──
  const toggleEmailOptions = () => {
    const type = typeSel.value;
    const show = !!type;
    document.getElementById('f_wv_email_options').style.display = show ? 'block' : 'none';
    if (show && !c) {
      document.getElementById('f_wv_confirm').checked = cfg.autoConfirm || false;
      document.getElementById('f_wv_reminder').checked = cfg.autoReminder || false;
    }
  };
  typeSel.addEventListener('change', toggleEmailOptions);
  toggleEmailOptions();

  document.getElementById('contactModal').classList.add('open');
};



document.getElementById('saveContact').addEventListener('click', async () => {
  const wvType = document.getElementById('f_wv_type').value;
  const data = {
    vorname: document.getElementById('f_vorname').value.trim(),
    nachname: document.getElementById('f_nachname').value.trim(),
    telefon: document.getElementById('f_telefon').value.trim(),
    email: document.getElementById('f_email').value.trim(),
    ort: document.getElementById('f_ort').value.trim(),
    thema: document.getElementById('f_thema').value.trim(),
    quelle: document.getElementById('f_quelle').value,
    status: document.getElementById('f_status').value,
    absagegrund: document.getElementById('f_absagegrund').value.trim(),
    notizen: document.getElementById('f_notizen').value.trim(),
    contactCategory: (auth.currentUser?.email === ALLOWED_EMAIL)
      ? (document.getElementById('f_category')?.value || null)
      : undefined,
    wiedervorlage: document.getElementById('f_wiedervorlage').value || null,
    wvType: wvType || null,
    wvNote: document.getElementById('f_wv_note').value.trim() || null,
    wvConfirm: (wvType === 'termin' || wvType === 'anruf') ? document.getElementById('f_wv_confirm').checked : false,
    wvReminder: (wvType === 'termin' || wvType === 'anruf') ? document.getElementById('f_wv_reminder').checked : false,
  };

  if (!data.vorname || !data.nachname) { toast('Bitte Vor- und Nachname eingeben.', 'error'); return; }

  // Pflichtfeld: Wenn ein Datum gesetzt ist, muss auch eine Terminart gewaehlt werden
  if (data.wiedervorlage && !wvType) {
    const typeField = document.getElementById('f_wv_type');
    if (typeField) {
      typeField.style.borderColor = '#ef4444';
      typeField.style.boxShadow = '0 0 0 2px rgba(239,68,68,0.25)';
      setTimeout(() => {
        typeField.style.borderColor = '';
        typeField.style.boxShadow = '';
      }, 2500);
      typeField.focus();
    }
    toast('Pflichtfeld: Bitte eine Terminart auswaehlen.', 'error');
    return;
  }

  // Strip undefined fields (e.g. contactCategory when non-admin) so Firestore doesn't error
  Object.keys(data).forEach(k => { if (data[k] === undefined) delete data[k]; });

  // If a Wiedervorlage with email is set, add a history entry and a callSlot
  const wvDate = data.wiedervorlage;
  if (wvDate && wvType) {
    const historyEntry = {
      type: wvType,
      datetime: wvDate,
      note: data.wvNote || 'Wiedervorlage',
      followup: null,
      wvConfirm: data.wvConfirm,
      wvReminder: data.wvReminder,
    };
    // Will be merged into history below after contact id is known
    data._pendingHistory = historyEntry;
  }

  try {
    let contactId = editingContactId;
    if (editingContactId) {
      const existingContact = contacts.find(c => c.id === editingContactId);
      const updatedHistory = existingContact?.history || [];
      if (data._pendingHistory) {
        updatedHistory.push(data._pendingHistory);
      }
      const { _pendingHistory, ...saveData } = data;
      await updateDoc(doc(db, 'contacts', editingContactId), { ...saveData, history: updatedHistory });
      toast('Kontakt aktualisiert!');
    } else {
      const { _pendingHistory, ...saveData } = data;
      saveData.createdAt = serverTimestamp();
      saveData.history = data._pendingHistory ? [data._pendingHistory] : [];
      const ref = await addDoc(collection(db, 'contacts'), saveData);
      contactId = ref.id;
      toast('Kontakt gespeichert!');
    }

    // Create callSlot if Wiedervorlage set
    if (wvDate && wvType && contactId && !contactId.startsWith('local_')) {
      // Dauer aus den Einstellungen lesen (Terminart-spezifisch)
      const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
      const apptTypeDef = (s.apptTypes || []).find(t => t.name === wvType);
      const apptDuration = apptTypeDef?.duration || 30;

      // ── Kollisionsprüfung ──────────────────────────────────
      const newStart = new Date(wvDate).getTime();
      const newEnd   = newStart + apptDuration * 60000;
      const conflict = callSlots.find(sl => {
        const exStart = new Date(sl.datetime).getTime();
        const exEnd   = exStart + (sl.apptDuration || 30) * 60000;
        return newStart < exEnd && newEnd > exStart;
      });
      if (conflict) {
        const conflictTime = new Date(conflict.datetime).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
        const conflictName = contacts.find(c => c.id === conflict.contactId);
        const nameStr = conflictName ? ` (${conflictName.vorname} ${conflictName.nachname})` : '';
        toast(`⚠️ Zeitkonflikt: Dieser Termin überschneidet sich mit einem bestehenden Termin am ${conflictTime}${nameStr}.`, 'error');
        return;
      }
      // ──────────────────────────────────────────────────────

      const slotDoc = {
        contactId,
        datetime: wvDate,
        type: 'fix',
        note: data.wvNote || '',
        apptType: wvType,
        apptDuration,
        sendConfirmEmail: data.wvConfirm,
        sendReminder: data.wvReminder,
      };
      const slotRef = await addDoc(collection(db, 'callSlots'), slotDoc).catch(() => null);
      if (slotRef) slotDoc.id = slotRef.id;

      // Google Kalender Sync
      const contactForSync = contacts.find(c => c.id === contactId) || { ...data, id: contactId };
      await syncToGoogleCalendar(slotDoc, contactForSync);

      // Bestätigung wird NICHT sofort verschickt, sondern automatisch
      // 1 Tag vor dem Termin (sendConfirmEmail-Flag oben, siehe GitHub-Actions-Skript).
      if (data.wvConfirm && data.email) {
        toast('📬 Bestätigung wird 1 Tag vor dem Termin automatisch per E-Mail versendet.', 'success');
      }
    }

    document.getElementById('contactModal').classList.remove('open');
  } catch (e) {
    // Fallback offline
    const localId = 'local_' + Date.now();
    if (editingContactId) {
      const idx = contacts.findIndex(c => c.id === editingContactId);
      if (idx !== -1) {
        const history = [...(contacts[idx].history || [])];
        if (data._pendingHistory) history.push(data._pendingHistory);
        const { _pendingHistory, ...saveData } = data;
        contacts[idx] = { ...contacts[idx], ...saveData, history };
      }
    } else {
      const { _pendingHistory, ...saveData } = data;
      const history = data._pendingHistory ? [data._pendingHistory] : [];
      contacts.unshift({ id: localId, createdAt: new Date().toISOString(), history, ...saveData });
      if (wvDate && wvType) {
        callSlots.push({ id: 'local_cs_' + Date.now(), contactId: localId, datetime: wvDate, type: 'fix', note: data.wvNote || '' });
      }
    }
    toast('Gespeichert (offline).');
    document.getElementById('contactModal').classList.remove('open');
    if (currentPage === 'contacts') renderContacts();
    if (currentPage === 'dashboard') renderDashboard();
  }
});

document.getElementById('closeModal').addEventListener('click', () => document.getElementById('contactModal').classList.remove('open'));
document.getElementById('cancelModal').addEventListener('click', () => document.getElementById('contactModal').classList.remove('open'));

// ============================================================
// HISTORY MODAL
// ============================================================
window.addHistoryEntry = function(contactId) {
  editingHistoryContactId = contactId;
  document.getElementById('h_datetime').value = now();
  document.getElementById('h_followup').value = '';
  document.getElementById('h_note').value = '';
  document.getElementById('h_type').value = 'anruf';
  document.getElementById('h_gcal').checked = false;
  document.getElementById('historyModal').classList.add('open');
};

document.getElementById('saveHistory').addEventListener('click', async () => {
  const entry = {
    type: document.getElementById('h_type').value,
    datetime: document.getElementById('h_datetime').value,
    note: document.getElementById('h_note').value.trim(),
    followup: document.getElementById('h_followup').value || null,
  };

  const c = contacts.find(x => x.id === editingHistoryContactId);
  if (!c) return;

  const history = [...(c.history || []), entry];

  // Google Calendar
  const gcal = document.getElementById('h_gcal').checked;
  if (gcal && entry.followup) {
    const settings = JSON.parse(localStorage.getItem('crmSettings') || '{}');
    openGoogleCalendar(c, entry, settings);
  }

  try {
    await updateDoc(doc(db, 'contacts', editingHistoryContactId), { history, status: c.status });
    toast('Eintrag gespeichert!');
  } catch {
    const idx = contacts.findIndex(x => x.id === editingHistoryContactId);
    if (idx !== -1) contacts[idx].history = history;
    toast('Eintrag gespeichert (offline).');
  }

  document.getElementById('historyModal').classList.remove('open');
  if (currentContactId === editingHistoryContactId) showContact(editingHistoryContactId);
});

document.getElementById('closeHistoryModal').addEventListener('click', () => document.getElementById('historyModal').classList.remove('open'));
document.getElementById('cancelHistoryModal').addEventListener('click', () => document.getElementById('historyModal').classList.remove('open'));

// ============================================================
// GOOGLE CALENDAR – API-Sync
// ============================================================
function openGoogleCalendar(contact, entry, settings) {
  // Fallback: open Google Calendar web UI (used from history modal without API key)
  const title = encodeURIComponent(`Folgetermin: ${contact.vorname} ${contact.nachname} – ${contact.thema || 'Gespräch'}`);
  const start = entry.followup.replace(/[-:T]/g, '').slice(0, 15) + '00Z';
  const end = new Date(new Date(entry.followup).getTime() + 30 * 60000).toISOString().replace(/[-:T]/g, '').slice(0, 15) + '00Z';
  const details = encodeURIComponent(`Kontakt: ${contact.telefon}\n${entry.note || ''}`);
  const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${start}/${end}&details=${details}`;
  window.open(url, '_blank');
}

// ============================================================
// TERMIN BENACHRICHTIGUNG – Gmail API (Google OAuth)
// ============================================================

// Google-Kalender "Termin hinzufügen"-Link erzeugen (für Klick-Button in E-Mails,
// im Gegensatz zur .ics-Datei funktioniert das ohne Anhang/Download – ein Klick
// öffnet direkt den vorausgefüllten Google-Kalender-Eintrag zum Speichern).
function buildGoogleCalendarLink(contact, slotData) {
  const dt = new Date(slotData.datetime);
  const dtEnd = new Date(dt.getTime() + (slotData.apptDuration || 30) * 60000);
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;

  const title = encodeURIComponent(`${slotData.apptType || 'Termin'}: ${contact.vorname} ${contact.nachname || ''}`.trim());
  const dates = `${fmt(dt)}/${fmt(dtEnd)}`;
  const details = encodeURIComponent(slotData.note || '');

  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dates}&details=${details}`;
}

// ICS-Kalender-Datei generieren
function generateICS(contact, slotData) {
  const dt = new Date(slotData.datetime);
  const dtEnd = new Date(dt.getTime() + (slotData.apptDuration || 30) * 60000);

  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  const uid = `termin-${Date.now()}@leadtracker`;

  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const organizer = s.gmailSender || s.myEmail || 'nawin.telis@gmail.com';
  const title = `${slotData.apptType || 'Termin'}: ${contact.vorname} ${contact.nachname}`.trim();
  const desc = (slotData.note || '').replace(/\n/g, '\\n');

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
    `DESCRIPTION:${desc}`,
    `ORGANIZER;CN=Nawin:mailto:${organizer}`,
    contact.email ? `ATTENDEE;CN=${contact.vorname} ${contact.nachname};RSVP=TRUE:mailto:${contact.email}` : '',
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

// Gmail OAuth Token holen – stille Erneuerung, Pop-up nur beim ersten Mal
async function getGmailToken() {
  const cacheKey = 'gmailOAuthToken';

  // Gecachten Token verwenden, wenn noch > 2 Minuten gültig (z.B. vom Login mitgebracht)
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.expires > Date.now() + 120000) return cached.token;
  } catch {}

  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const clientId = s.gcalOAuthClientId || '';
  const senderEmail = s.gmailSender || 'nawin.telis@gmail.com';
  if (!clientId) return null;

  // Hilfsfunktion: Token anfordern (silent oder mit Pop-up)
  const requestToken = (promptMode) => new Promise((resolve) => {
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/gmail.send',
      hint: senderEmail,
      callback: (resp) => {
        if (resp.error || !resp.access_token) { resolve(null); return; }
        localStorage.setItem(cacheKey, JSON.stringify({
          token: resp.access_token,
          expires: Date.now() + ((resp.expires_in || 3600) * 1000),
        }));
        resolve(resp.access_token);
      },
      error_callback: () => resolve(null),
    });
    tokenClient.requestAccessToken({ prompt: promptMode });
  });

  const doRequest = async () => {
    // Erst lautlos versuchen (kein Pop-up)
    const silentToken = await requestToken('none');
    if (silentToken) return silentToken;
    // Falls stille Erneuerung scheitert → einmalig Pop-up
    return await requestToken('');
  };

  if (typeof google !== 'undefined' && google?.accounts?.oauth2) {
    return await doRequest();
  } else {
    return new Promise((resolve) => {
      const sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client';
      sc.onload = () => doRequest().then(resolve);
      sc.onerror = () => resolve(null);
      document.head.appendChild(sc);
    });
  }
}

// E-Mail als RFC 2822 bauen und als base64url kodieren (für Gmail API)
// inlineImage: { cid, base64DataUrl } – wird als Inline-Bild eingebettet
function buildGmailMessage(to, toName, from, subject, htmlBody, icsContent, inlineImage) {
  const outerBoundary = `outer_${Date.now()}`;
  const relBoundary  = `related_${Date.now() + 1}`;

  // Wenn ein Inline-Bild vorhanden: multipart/related um html+bild, dann multipart/mixed drum herum
  // Sonst: einfach multipart/mixed
  let htmlPart;
  if (inlineImage) {
    // Bild-Daten: aus "data:image/xxx;base64,XXXX" nur den Base64-Teil nehmen
    const b64 = inlineImage.base64DataUrl.split(',')[1] || '';
    const mime = (inlineImage.base64DataUrl.match(/^data:(image\/[^;]+);/) || [])[1] || 'image/png';
    htmlPart = [
      `--${relBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      htmlBody,
      '',
      `--${relBoundary}`,
      `Content-Type: ${mime}`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${inlineImage.cid}>`,
      'Content-Disposition: inline',
      '',
      b64,
      '',
      `--${relBoundary}--`,
    ].join('\r\n');
    htmlPart = [
      `Content-Type: multipart/related; boundary="${relBoundary}"`,
      '',
      htmlPart,
    ].join('\r\n');
  } else {
    htmlPart = [
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      htmlBody,
    ].join('\r\n');
  }

  const parts = [
    `From: ${from}`,
    `To: ${toName} <${to}>`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${outerBoundary}"`,
    '',
    `--${outerBoundary}`,
    htmlPart,
    '',
  ];

  if (icsContent) {
    const icsBase64 = btoa(unescape(encodeURIComponent(icsContent)));
    parts.push(
      `--${outerBoundary}`,
      // "inline" statt "attachment": Gmail/Outlook erkennen die .ics als echte
      // Termineinladung und zeigen direkt in der Mail einen "In Kalender eintragen"-
      // Button – ohne dass der Empfänger irgendetwas herunterladen muss.
      'Content-Type: text/calendar; method=REQUEST; name="invite.ics"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: inline; filename="invite.ics"',
      '',
      icsBase64,
      '',
    );
  }

  parts.push(`--${outerBoundary}--`);

  const raw = parts.join('\r\n');
  return btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Hauptfunktion: E-Mail über Gmail versenden
async function sendConfirmationEmail(contact, slotData) {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');

  if (!contact?.email) {
    toast('⚠️ Kein E-Mail für diesen Kontakt hinterlegt.', 'error');
    return;
  }

  const from = s.gmailSender || 'nawin.telis@gmail.com';
  const dt = new Date(slotData.datetime);
  const datum = dt.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const uhrzeit = dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  const isReminder = slotData.isReminder === true || slotData.mailType === 'reminder';
  const isNotify = !isReminder && (slotData.mailType === 'notify');

  let subject, rawTemplate;
  if (isReminder) {
    subject = (s.reminderSubject || 'Erinnerung: Unser Termin heute um {uhrzeit} Uhr')
      .replace('{datum}', datum).replace('{uhrzeit}', uhrzeit);
    rawTemplate = s.emailReminderText;
  } else if (isNotify) {
    subject = (s.notifySubject || 'Ihr Termin am {datum}')
      .replace('{datum}', datum).replace('{uhrzeit}', uhrzeit);
    rawTemplate = s.emailNotifyText;
  } else {
    subject = (s.confirmSubject || 'Terminbestätigung – {datum}')
      .replace('{datum}', datum).replace('{uhrzeit}', uhrzeit);
    rawTemplate = s.emailConfirmText;
  }

  const bodyText = (rawTemplate ||
`Hallo {vorname},

hiermit bestätige ich unseren gemeinsamen Termin am {datum} um {uhrzeit} Uhr.

Im Anhang findest du eine Kalender-Datei – einfach anklicken und der Termin wird direkt in deinen Kalender eingetragen.

Bei Fragen stehe ich dir gerne zur Verfügung.

{signatur}`)
    .replace(/{vorname}/g, contact.vorname || '')
    .replace(/{nachname}/g, contact.nachname || '')
    .replace(/{datum}/g, datum)
    .replace(/{uhrzeit}/g, uhrzeit)
    .replace(/{signatur}/g, s.emailSig || '');

  // Google-Kalender-Link für Klick-Button (funktioniert ohne .ics-Anhang/Download)
  const gcalUrl = buildGoogleCalendarLink(contact, slotData);
  const gcalButtonHtml = `<div style="margin:20px 0;"><a href="${gcalUrl}" target="_blank" style="background:#4285f4;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-family:Arial,sans-serif;font-size:14px;display:inline-block;">📅 Termin zu Google Kalender hinzufügen</a></div>`;

  // Bild inline einbetten: {bild} → <img src="cid:sigimage"> als MIME-Part
  const sigImageBase64 = s.emailSigImage || '';
  const hasSigImage = !!sigImageBase64 && bodyText.includes('{bild}');
  const sigImageCid = 'sigimage@leadtracker';

  // Signaturtext: {bild} durch img-Tag ersetzen (für htmlBody), oder entfernen (kein Bild),
  // {kalenderlink} durch reine URL ersetzen (für Plain-Text bzw. eigene Verlinkung in der Vorlage)
  const htmlBodyRaw = bodyText
    .replace(/{bild}/g, hasSigImage ? `<img src="cid:${sigImageCid}" style="max-height:80px;max-width:200px;display:block;margin-top:6px;" alt="Signatur" />` : '')
    .replace(/{kalenderlink}/g, gcalUrl)
    .replace(/\n/g, '<br>');

  // Falls die Vorlage den Platzhalter {kalenderlink} nicht selbst nutzt, wird der
  // Button automatisch ergänzt – bei der Benachrichtigung (kein .ics-Anhang) ist
  // das der einzige Weg, den Termin direkt in den Kalender zu bekommen.
  const hasOwnLinkPlaceholder = bodyText.includes('{kalenderlink}');
  const htmlBody = hasOwnLinkPlaceholder ? htmlBodyRaw : htmlBodyRaw + gcalButtonHtml;

  const icsContent = generateICS(contact, slotData);

  toast(`📧 E-Mail wird über Gmail gesendet...`);

  const token = await getGmailToken();
  if (!token) {
    toast('⚠️ Gmail-Login fehlgeschlagen – Mailclient wird als Fallback geöffnet.', 'error');
    const plainBody = hasOwnLinkPlaceholder
      ? bodyText.replace(/{kalenderlink}/g, gcalUrl)
      : `${bodyText}\n\n📅 Termin zu Google Kalender hinzufügen:\n${gcalUrl}`;
    const mailtoUrl = `mailto:${contact.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plainBody)}`;
    window.open(mailtoUrl, '_blank');
    return;
  }

  const rawMessage = buildGmailMessage(
    contact.email,
    `${contact.vorname} ${contact.nachname}`,
    from,
    subject,
    htmlBody,
    slotData.withIcs !== false ? icsContent : null,
    hasSigImage ? { cid: sigImageCid, base64DataUrl: sigImageBase64 } : null
  );

  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: rawMessage }),
    });

    if (res.ok) {
      const label = isReminder ? 'Terminerinnerung' : (isNotify ? 'Terminbenachrichtigung' : 'Terminbestätigung');
      toast(`✅ ${label} an ${contact.vorname} gesendet${slotData.withIcs !== false ? ' – inkl. Kalender-Einladung!' : '!'}`, 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) {
        localStorage.removeItem('gmailOAuthToken');
        toast('🔄 Token abgelaufen – bitte erneut versuchen.', 'error');
      } else {
        toast(`❌ Gmail Fehler: ${err?.error?.message || res.status}`, 'error');
      }
    }
  } catch (e) {
    console.error('Gmail Sendefehler:', e);
    toast('❌ Verbindungsfehler beim E-Mail-Versand.', 'error');
  }
}

// ============================================================
// GOOGLE OAUTH – Termine automatisch eintragen
// ============================================================
async function getGCalOAuthToken(hint) {
  const cacheKey = 'gcalOAuthToken_' + hint;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.expires > Date.now() + 60000) return cached.token;
  } catch {}

  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const clientId = s.gcalOAuthClientId || '';
  if (!clientId) return null;

  return new Promise((resolve) => {
    const doRequest = () => {
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: 'https://www.googleapis.com/auth/calendar.events',
        hint,
        callback: (resp) => {
          if (resp.error || !resp.access_token) { resolve(null); return; }
          localStorage.setItem(cacheKey, JSON.stringify({
            token: resp.access_token,
            expires: Date.now() + (resp.expires_in * 1000),
          }));
          resolve(resp.access_token);
        },
      });
      tokenClient.requestAccessToken({ prompt: '' });
    };
    if (typeof google !== 'undefined' && google?.accounts?.oauth2) {
      doRequest();
    } else {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = doRequest;
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    }
  });
}

async function syncToGoogleCalendar(slotData, contactData) {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');

  const start = new Date(slotData.datetime);
  const end = new Date(start.getTime() + (slotData.apptDuration || 30) * 60000);

  const event = {
    summary: `${slotData.apptType || 'Termin'}: ${contactData?.vorname || ''} ${contactData?.nachname || ''}`.trim(),
    description: [slotData.note || '', contactData?.telefon ? `Tel: ${contactData.telefon}` : ''].filter(Boolean).join('\n'),
    start: { dateTime: start.toISOString(), timeZone: 'Europe/Berlin' },
    end:   { dateTime: end.toISOString(),   timeZone: 'Europe/Berlin' },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 30 }],
    },
  };

  const calendars = [
    { id: s.gcalId,  email: s.gcalId  },
    { id: s.gcalId2, email: s.gcalId2 },
  ].filter(c => c.id);
  if (calendars.length === 0) return;

  let successCount = 0;
  const gcalEventIds = {};
  for (const cal of calendars) {
    const token = await getGCalOAuthToken(cal.email);
    if (!token) continue;
    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(event) }
      );
      if (res.ok) {
        successCount++;
        const created = await res.json();
        if (created.id) gcalEventIds[cal.id] = created.id;
      } else {
        const err = await res.json();
        console.warn(`GCal Fehler (${cal.id}):`, err);
        if (res.status === 401) localStorage.removeItem('gcalOAuthToken_' + cal.email);
      }
    } catch(e) { console.warn('GCal sync error:', e.message); }
  }

  if (successCount > 0) {
    toast(`✅ In ${successCount > 1 ? 'beiden Google Kalendern' : 'Google Kalender'} eingetragen (⏰ 30 Min. Erinnerung)!`, 'success');
    if (Object.keys(gcalEventIds).length > 0 && slotData.id) {
      try {
        await updateDoc(doc(db, 'callSlots', slotData.id), { gcalEventIds });
      } catch(e) { console.warn('gcalEventIds speichern fehlgeschlagen:', e.message); }
    }
    setTimeout(() => loadGoogleCalendarEvents(), 1500);
  } else {
    openGoogleCalendar(
      { vorname: contactData?.vorname||'', nachname: contactData?.nachname||'', telefon: contactData?.telefon||'', thema: slotData.apptType||'' },
      { followup: slotData.datetime, note: slotData.note }, s
    );
  }
}

// ============================================================
// GOOGLE CALENDAR IMPORT – Termine aus beiden Kalendern lesen
// ============================================================
let googleCalendarEvents = [];

async function loadGoogleCalendarEvents() {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  if (!s.gcalKey) return;

  const calendars = [
    { id: s.gcalId,  key: s.gcalKey,  label: 'Kalender 1' },
    { id: s.gcalId2, key: s.gcalKey2, label: 'Kalender 2' },
  ].filter(c => c.id && c.key);
  if (calendars.length === 0) return;

  const now = new Date();
  const timeMin = encodeURIComponent(new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString());
  const timeMax = encodeURIComponent(new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString());

  googleCalendarEvents = [];

  for (const cal of calendars) {
    const calId = cal.id;
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?key=${cal.key}&timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=100`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const events = (data.items || []).map(e => ({
          id: e.id,
          title: e.summary || '(kein Titel)',
          datetime: e.start?.dateTime || e.start?.date || '',
          end: e.end?.dateTime || e.end?.date || '',
          calendarId: calId,
          calendarLabel: cal.label,
          source: 'google',
          htmlLink: e.htmlLink,
        }));
        googleCalendarEvents.push(...events);
      }
    } catch(e) {
      console.warn(`Google Calendar Import fehlgeschlagen (${calId}):`, e.message);
    }
  }

  // Re-render calendar if open
  if (currentPage === 'calendar') renderCalendar();

  // Buchungs-Dialog aktualisieren falls offen (GCal-Termine jetzt verfügbar)
  if (document.getElementById('callSlotModal')?.classList.contains('open')) {
    const step2 = document.getElementById('cs_step2');
    if (step2 && step2.style.display !== 'none') _csRenderCal();
  }
}

// ============================================================
// CALENDAR PAGE
// ============================================================
let calWeekOffset = 0;

window.setCalWeekOffset = function(w) {
  calWeekOffset = w;
  renderCalendar();
};

window.calPrevWeek = function() {
  calWeekOffset--;
  renderCalendar();
};

window.calNextWeek = function() {
  calWeekOffset++;
  renderCalendar();
};

window.calGoToday = function() {
  calWeekOffset = 0;
  renderCalendar();
};

function renderCalendar() {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const availDays = s.availDays || [1,2,3,4,5];
  const blockedDates = s.blockedDates || [];
  const dayConfigs = s.dayConfigs || {};

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const baseMon = new Date(today);
  const dow = today.getDay() === 0 ? 6 : today.getDay() - 1;
  baseMon.setDate(today.getDate() - dow);
  const monday = new Date(baseMon);
  monday.setDate(baseMon.getDate() + calWeekOffset * 7);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i); return d;
  });

  const names = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const weekStr = `${monday.toLocaleDateString('de-DE', { day:'2-digit', month:'long' })} – ${days[6].toLocaleDateString('de-DE', { day:'2-digit', month:'long', year:'numeric' })}`;
  const weekLabel = calWeekOffset === 0 ? 'Diese Woche' : calWeekOffset === 1 ? 'Nächste Woche' : calWeekOffset === 2 ? 'Übernächste Woche' : calWeekOffset < 0 ? `${Math.abs(calWeekOffset)} Woche${Math.abs(calWeekOffset)>1?'n':''} zurück` : `+${calWeekOffset} Wochen`;

  // Nur geschäftliche Slots – private Termine werden strikt über privateSlotsByDay gerendert
  // (verhindert doppelte Anzeige im Wochenplan)
  // Vergangene Termine werden nicht angezeigt
  const now = new Date();
  const allCalSlots = [...callSlots].filter(sl => new Date(sl.datetime) >= now);

  const slotsByDay = days.map(d => allCalSlots.filter(sl => {
    const slStart = new Date(sl.datetime);
    const slEnd = new Date(slStart.getTime() + (sl.apptDuration || 30) * 60000);
    const dStart = new Date(d); dStart.setHours(0,0,0,0);
    const dEnd = new Date(d); dEnd.setHours(23,59,59,999);
    return slStart <= dEnd && slEnd > dStart;
  }));

  // Private Termine für den Wochenplan (bestätigte + anfragen, strikt getrennt, nur zukünftige)
  const privateSlotsByDay = days.map(d => privateSlots.filter(sl => {
    const slStart = new Date(sl.datetime);
    if (slStart < now) return false;
    const slEnd = new Date(slStart.getTime() + (sl.apptDuration || 60) * 60000);
    const dStart = new Date(d); dStart.setHours(0,0,0,0);
    const dEnd = new Date(d); dEnd.setHours(23,59,59,999);
    return slStart <= dEnd && slEnd > dStart;
  }));

  // All-day events (date-only string, no 'T') shown in banner row
  const gcalAllDay = days.map(d => googleCalendarEvents.filter(e => {
    if (!e.datetime || e.datetime.includes('T')) return false;
    const eStart = new Date(e.datetime + 'T00:00:00');
    const eEnd = e.end ? new Date(e.end + 'T00:00:00') : new Date(eStart.getTime() + 86400000);
    const dMid = new Date(d); dMid.setHours(12,0,0,0);
    return eStart <= dMid && eEnd > dMid;
  }));

  // Timed events: appear on every day they span
  // Dedup: GCal-Events ausblenden die bereits als callSlot/privateSlot gerendert werden
  const allSlotGcalIds = new Set(
    [...callSlots, ...privateSlots]
      .flatMap(s => s.gcalEventIds ? Object.values(s.gcalEventIds) : [])
  );
  const allSlotLocalKeys = new Set(
    [...callSlots, ...privateSlots]
      .filter(s => s.datetime)
      .map(s => {
        const d = new Date(s.datetime);
        return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() + '-' + d.getHours() + '-' + d.getMinutes();
      })
  );
  const gcalByDay = days.map(d => googleCalendarEvents.filter(e => {
    if (!e.datetime || !e.datetime.includes('T')) return false;
    if (allSlotGcalIds.has(e.id)) return false;
    const eStart = new Date(e.datetime);
    const localKey = eStart.getFullYear() + '-' + eStart.getMonth() + '-' + eStart.getDate() + '-' + eStart.getHours() + '-' + eStart.getMinutes();
    if (allSlotLocalKeys.has(localKey)) return false;
    const eEnd = e.end && e.end.includes('T') ? new Date(e.end) : new Date(eStart.getTime() + 30*60000);
    const dStart = new Date(d); dStart.setHours(0,0,0,0);
    const dEnd = new Date(d); dEnd.setHours(23,59,59,999);
    return eStart <= dEnd && eEnd > dStart;
  }));
  const totalWeek = slotsByDay.reduce((a, b) => a + b.length, 0) + privateSlotsByDay.reduce((a, b) => a + b.length, 0);

  // Compute global earliest start and latest end across all active days
  function timeToMinutes(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }
  function minutesToTime(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  let globalStart = null;
  let globalEnd = null;

  days.forEach((d, i) => {
    const dayNum = d.getDay();
    const isUnavailable = !availDays.includes(dayNum);
    const dateStr = d.toISOString().slice(0,10);
    const isBlocked = blockedDates.includes(dateStr);
    if (isUnavailable || isBlocked) return;
    const dc = dayConfigs[dayNum] || {};
    const startMin = timeToMinutes(dc.start || '09:00');
    const endMin = timeToMinutes(dc.end || '18:00');
    if (globalStart === null || startMin < globalStart) globalStart = startMin;
    if (globalEnd === null || endMin > globalEnd) globalEnd = endMin;
    // Also consider actual slot times (incl. private Termine außerhalb Geschäftszeiten)
    slotsByDay[i].forEach(sl => {
      const slDate = new Date(sl.datetime);
      const slMin = slDate.getHours() * 60 + slDate.getMinutes();
      const slEndMin = slMin + (sl.apptDuration || 30);
      if (globalStart === null || slMin < globalStart) globalStart = slMin;
      if (globalEnd === null || slEndMin > globalEnd) globalEnd = slEndMin;
    });
    // Private Termine ebenfalls einbeziehen (können außerhalb der Geschäftszeiten liegen)
    privateSlotsByDay[i].forEach(sl => {
      const slDate = new Date(sl.datetime);
      const slMin = slDate.getHours() * 60 + slDate.getMinutes();
      const slEndMin = slMin + (sl.apptDuration || 60);
      if (globalStart === null || slMin < globalStart) globalStart = slMin;
      if (globalEnd === null || slEndMin > globalEnd) globalEnd = slEndMin;
    });
  });

  // GCal-Events ebenfalls in Zeitbereich einbeziehen
  days.forEach((d, i) => {
    (gcalByDay[i] || []).forEach(e => {
      if (!e.datetime || !e.datetime.includes('T')) return;
      const eDate   = new Date(e.datetime);
      const eEnd    = e.end && e.end.includes('T') ? new Date(e.end) : new Date(eDate.getTime() + 30*60000);
      const eMin    = eDate.getHours() * 60 + eDate.getMinutes();
      const eEndMin = eEnd.getHours()  * 60 + eEnd.getMinutes();
      if (globalStart === null || eMin    < globalStart) globalStart = eMin;
      if (globalEnd   === null || eEndMin > globalEnd)   globalEnd   = eEndMin;
    });
  });

  // Fallback if no available days
  if (globalStart === null) { globalStart = 9 * 60; globalEnd = 18 * 60; }

  // Round to 30-min boundaries
  globalStart = Math.floor(globalStart / 30) * 30;
  globalEnd = Math.ceil(globalEnd / 30) * 30;

  // Generate time slots array (30-min increments)
  const timeSlots = [];
  for (let t = globalStart; t < globalEnd; t += 30) {
    timeSlots.push(t);
  }

  const ROW_HEIGHT = 44; // px per 30-min slot
  const HEADER_HEIGHT = 72; // px for day header

  document.getElementById('content').innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap;">
      <button onclick="calPrevWeek()" class="btn-ghost" style="padding:8px 14px;font-size:14px;display:flex;align-items:center;gap:6px;" title="Vorherige Woche">
        <i class="ti ti-chevron-left"></i> Zurück
      </button>
      <div style="flex:1;min-width:0;text-align:center;">
        <div style="font-size:18px;font-weight:700;">${weekStr}</div>
        <div style="font-size:13px;color:var(--text3);margin-top:2px;">${weekLabel} · ${totalWeek} Termin${totalWeek!==1?'e':''}</div>
      </div>
      <button onclick="calNextWeek()" class="btn-ghost" style="padding:8px 14px;font-size:14px;display:flex;align-items:center;gap:6px;" title="Nächste Woche">
        Vor <i class="ti ti-chevron-right"></i>
      </button>
      <button class="btn-primary" onclick="openCallSlotModal()"><i class="ti ti-plus"></i> Einplanen</button>
    </div>

    <!-- Week nav pills -->
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">
      ${[-1,0,1,2].map(w => {
        const active = calWeekOffset === w;
        const lbl = w === -1 ? '← Letzte Woche' : w === 0 ? 'Diese Woche' : w === 1 ? 'Nächste Woche' : 'Übernächste Woche';
        return `<button onclick="setCalWeekOffset(${w})"
          style="font-size:13px;padding:7px 16px;border-radius:20px;border:1.5px solid ${active?'var(--accent)':'var(--border2)'};
          background:${active?'rgba(59,130,246,0.15)':'var(--surface)'};color:${active?'var(--accent)':'var(--text2)'};
          cursor:pointer;transition:all .15s;font-weight:${active?'600':'400'};
          box-shadow:${active?'0 0 0 3px rgba(59,130,246,0.15)':'none'};">${lbl}</button>`;
      }).join('')}
      ${calWeekOffset !== 0 ? `<button onclick="calGoToday()" style="font-size:13px;padding:7px 16px;border-radius:20px;border:1.5px solid var(--border2);background:var(--surface);color:var(--text2);cursor:pointer;margin-left:auto;"><i class="ti ti-calendar-event"></i> Heute</button>` : ''}
    </div>

    <!-- Timeline grid -->
    <div style="overflow-x:auto;overflow-y:auto;max-height:75vh;">
      <div style="display:grid;grid-template-columns:52px repeat(7,minmax(110px,1fr));min-width:830px;position:relative;">

        <!-- Corner cell -->
        <div style="position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:2px solid var(--border);height:${HEADER_HEIGHT}px;"></div>

        <!-- Day headers -->
        ${days.map((d, i) => {
          const isToday = d.toDateString() === new Date().toDateString();
          const dayNum = d.getDay();
          const isUnavailable = !availDays.includes(dayNum);
          const dateStr = d.toISOString().slice(0,10);
          const isBlocked = blockedDates.includes(dateStr);
          return `
          <div style="
            position:sticky;top:0;z-index:10;
            height:${HEADER_HEIGHT}px;
            background:${isToday ? 'rgba(59,130,246,0.1)' : 'var(--bg)'};
            border-bottom:2px solid ${isToday ? 'var(--accent)' : 'var(--border)'};
            border-left:1px solid var(--border);
            padding:10px 10px 8px;
            display:flex;flex-direction:column;justify-content:center;
            ${isUnavailable||isBlocked ? 'opacity:0.4;' : ''}
          ">
            <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${isToday?'var(--accent)':'var(--text3)'};">${names[i]}</div>
            <div style="font-size:28px;font-weight:900;color:${isToday?'var(--accent)':'var(--text)'};line-height:1.05;margin-top:1px;">${d.getDate()}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:1px;">${d.toLocaleDateString('de-DE',{month:'short',year:'numeric'})}${isBlocked?' · 🚫':isUnavailable?' · –':''}</div>
          </div>`;
        }).join('')}

        <!-- All-day events banner row -->
        <div style="font-size:10px;color:var(--text3);padding:4px 4px;text-align:right;border-bottom:1px solid var(--border);background:var(--bg);position:sticky;top:${HEADER_HEIGHT}px;z-index:9;display:flex;align-items:center;justify-content:flex-end;">ganztägig</div>
        ${days.map((d, i) => {
          const allDayHere = gcalAllDay[i];
          return `<div style="
            border-left:1px solid var(--border);
            border-bottom:1px solid var(--border);
            background:var(--bg);
            position:sticky;top:${HEADER_HEIGHT}px;z-index:9;
            min-height:24px;padding:2px 4px;display:flex;flex-direction:column;gap:2px;
          ">${allDayHere.map(e => {
            const color = e.calendarLabel === 'Kalender 2' ? '#10b981' : '#f97316';
            return `<div title="${e.title}" onclick="window.open('${e.htmlLink||''}','_blank')" style="
              background:${color}33;border-left:3px solid ${color};border-radius:4px;
              padding:1px 5px;font-size:10px;font-weight:600;color:${color};
              cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
            ">${e.title}</div>`;
          }).join('')}</div>`;
        }).join('')}

        <!-- Time labels + rows -->
        ${timeSlots.map((slotMin, rowIdx) => {
          const isHour = slotMin % 60 === 0;
          const timeLabel = minutesToTime(slotMin);

          // Time label cell
          const timeLabelCell = `
          <div style="
            height:${ROW_HEIGHT}px;
            display:flex;align-items:flex-start;justify-content:flex-end;
            padding-right:8px;padding-top:4px;
            position:relative;
          ">
            ${isHour ? `<span style="font-size:11px;font-weight:600;color:var(--text3);white-space:nowrap;">${timeLabel}</span>` : `<span style="font-size:10px;color:var(--border2);white-space:nowrap;">${timeLabel}</span>`}
          </div>`;

          // Day columns for this row
          const dayCells = days.map((d, i) => {
            const dayNum = d.getDay();
            const isUnavailable = !availDays.includes(dayNum);
            const dateStr = d.toISOString().slice(0,10);
            const isBlocked = blockedDates.includes(dateStr);
            const isToday = d.toDateString() === new Date().toDateString();
            const dc = dayConfigs[dayNum] || {};
            const dayStartMin = timeToMinutes(dc.start || '09:00');
            const dayEndMin = timeToMinutes(dc.end || '18:00');
            const breakStartMin = dc.breakStart ? timeToMinutes(dc.breakStart) : null;
            const breakEndMin = dc.breakEnd ? timeToMinutes(dc.breakEnd) : null;

            const inWorkHours = !isUnavailable && !isBlocked && slotMin >= dayStartMin && slotMin < dayEndMin;
            const inBreak = inWorkHours && breakStartMin !== null && slotMin >= breakStartMin && slotMin < breakEndMin;

            // Find slots that START in this time cell
            const slotsHere = slotsByDay[i].filter(sl => {
              const slDate = new Date(sl.datetime);
              const slMin = slDate.getHours() * 60 + slDate.getMinutes();
              return slMin >= slotMin && slMin < slotMin + 30;
            });

            // Private Termine die in diese Zelle fallen (strikt getrennt, amber-Farbe)
            const privateSlotsHere = privateSlotsByDay[i].filter(sl => {
              const slDate = new Date(sl.datetime);
              const slMin = slDate.getHours() * 60 + slDate.getMinutes();
              return slMin >= slotMin && slMin < slotMin + 30;
            });

            let cellBg = 'transparent';
            if (isUnavailable || isBlocked) cellBg = 'rgba(0,0,0,0.03)';
            else if (inBreak) cellBg = 'rgba(245,158,11,0.07)';
            else if (inWorkHours) cellBg = isToday ? 'rgba(59,130,246,0.03)' : 'rgba(255,255,255,0.01)';

            const clickIso = (() => {
              const dd = new Date(d);
              dd.setHours(Math.floor(slotMin/60), slotMin%60, 0, 0);
              return dd.toISOString();
            })();

            // Google Calendar events in this cell
            // For multi-day events, on continuation days show from globalStart
            const gcalHere = gcalByDay[i].filter(e => {
              if (!e.datetime) return false;
              const eDate = new Date(e.datetime);
              const isSameDay = eDate.toDateString() === d.toDateString();
              if (isSameDay) {
                // Start day: show at actual start time
                const eMin = eDate.getHours() * 60 + eDate.getMinutes();
                return eMin >= slotMin && eMin < slotMin + 30;
              } else {
                // Continuation day: show at the very first time slot (globalStart)
                return slotMin === globalStart;
              }
            });

            return `
            <div style="
              height:${ROW_HEIGHT}px;
              background:${cellBg};
              border-left:1px solid var(--border);
              border-bottom:1px solid ${isHour ? 'var(--border)' : 'rgba(255,255,255,0.04)'};
              position:relative;
              ${isUnavailable||isBlocked ? 'opacity:0.35;' : ''}
            ">
              ${inBreak && !slotsHere.length ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text3);opacity:0.6;">🍽</div>` : ''}
              ${gcalHere.map(e => {
                const eDate = new Date(e.datetime);
                const eEndDate = e.end && e.end.includes('T') ? new Date(e.end) : new Date(eDate.getTime() + 30*60000);
                const gcalColor = e.calendarLabel === 'Kalender 2' ? '#10b981' : '#f97316';
                const isSameDay = eDate.toDateString() === d.toDateString();
                const isMultiDay = eDate.toDateString() !== eEndDate.toDateString();

                // Clamp display to this day's visible range
                const dayVisStart = new Date(d); dayVisStart.setHours(Math.floor(globalStart/60), globalStart%60, 0, 0);
                const dayVisEnd = new Date(d); dayVisEnd.setHours(Math.floor(globalEnd/60), globalEnd%60, 0, 0);
                const dispStart = isSameDay ? eDate : dayVisStart;
                const dispEnd = eEndDate.toDateString() === d.toDateString() ? eEndDate : dayVisEnd;

                const startMin = dispStart.getHours() * 60 + dispStart.getMinutes();
                const endMin = dispEnd.getHours() * 60 + dispEnd.getMinutes();
                const durMin = Math.max(30, endMin - startMin);
                const slotCount = Math.ceil(durMin / 30);
                const heightPx = slotCount * ROW_HEIGHT - 4;
                const offsetPx = ((startMin - slotMin) / 30) * ROW_HEIGHT;

                const continuesPrev = !isSameDay;
                const continuesNext = eEndDate.toDateString() !== d.toDateString() && eEndDate > dayVisEnd;

                const timeLabel = continuesPrev
                  ? `↩ seit ${eDate.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'})}`
                  : eDate.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
                const endSuffix = continuesNext ? ' →' : '';

                return `
                <div title="${e.title} (${e.calendarLabel})" style="
                  position:absolute;
                  top:${offsetPx + 2}px;
                  left:3px;right:3px;
                  height:${heightPx}px;
                  background:${gcalColor}22;
                  border-left:3px solid ${gcalColor};
                  border-top:${continuesPrev ? '2px dashed ' + gcalColor : 'none'};
                  border-radius:${continuesPrev ? '0 4px 4px 0' : continuesNext ? '6px 6px 0 0' : '6px'};
                  padding:3px 6px;
                  cursor:pointer;
                  overflow:hidden;
                  z-index:1;
                  box-shadow:0 1px 4px rgba(0,0,0,0.1);
                  transition:opacity .15s;
                " onmouseover="this.style.opacity='.8';this.querySelector('.gcal-del')&&(this.querySelector('.gcal-del').style.display='flex')" onmouseout="this.style.opacity='1';this.querySelector('.gcal-del')&&(this.querySelector('.gcal-del').style.display='none')">
                  <div onclick="window.open('${e.htmlLink||''}','_blank')" style="min-width:0;">
                    <div style="font-size:10px;font-weight:600;color:${gcalColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                      ${timeLabel}${endSuffix} · ${e.calendarLabel}
                    </div>
                    <div style="font-size:11px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;margin-top:1px;">${e.title}</div>
                  </div>
                  <button class="gcal-del" onclick="event.stopPropagation();deleteGCalEventDirect('${e.id}','${e.calendarId}','${e.calendarLabel}')" style="
                    display:none;position:absolute;top:3px;right:3px;
                    background:rgba(239,68,68,0.15);border:none;border-radius:4px;
                    color:#ef4444;cursor:pointer;padding:2px 5px;font-size:12px;
                    align-items:center;justify-content:center;
                  " title="Aus Google Kalender löschen"><i class="ti ti-trash"></i></button>
                </div>`;
              }).join('')}
              ${slotsHere.map(sl => {
                const isPrivate = sl.privateBooking === true;
                const isStaff   = sl.isStaff === true;
                const c = !isPrivate ? contacts.find(x => x.id === sl.contactId) : null;
                const name = isPrivate
                  ? (sl.vorname ? `${sl.vorname}${sl.nachname ? ' ' + sl.nachname : ''}` : sl.bookedBy || 'Privat')
                  : (c ? `${c.vorname} ${c.nachname}` : (sl.vorname ? `${sl.vorname} ${sl.nachname||''}`.trim() : '?'));
                // Farblogik: Mitarbeiter = lila, Privat = amber, sonst apptColor / blau
                const color = isPrivate ? '#f59e0b'
                            : isStaff   ? '#8b5cf6'
                            : (sl.apptColor || (sl.type === 'flex' ? '#f59e0b' : '#3b82f6'));
                const slDate = new Date(sl.datetime);
                const slMin = slDate.getHours() * 60 + slDate.getMinutes();
                const dur = sl.apptDuration || 30;
                const slotCount = Math.max(1, dur / 30);
                const heightPx = slotCount * ROW_HEIGHT - 4;
                const offsetPx = ((slMin - slotMin) / 30) * ROW_HEIGHT;
                return `
                <div title="${sl.note || name}${isPrivate ? ' (Privat)' : ''}" style="
                  position:absolute;
                  top:${offsetPx + 2}px;
                  left:3px;right:3px;
                  height:${heightPx}px;
                  background:${color}22;
                  border-left:3px solid ${color};
                  border-radius:6px;
                  padding:3px 6px;
                  cursor:${isPrivate ? 'default' : 'pointer'};
                  overflow:hidden;
                  z-index:2;
                  transition:opacity .15s;
                  box-shadow:0 1px 4px rgba(0,0,0,0.15);
                  ${isPrivate ? 'border-style: solid dashed solid solid;' : ''}
                " onmouseover="this.style.opacity='.85';${!isPrivate ? `this.querySelector('.slot-del')&&(this.querySelector('.slot-del').style.display='flex')` : ''}" onmouseout="this.style.opacity='1';${!isPrivate ? `this.querySelector('.slot-del')&&(this.querySelector('.slot-del').style.display='none')` : ''}">
                  <div ${!isPrivate ? `onclick="showContact('${sl.contactId||''}')"` : ''} style="min-width:0;">
                    <div style="font-size:11px;font-weight:700;color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                      ${isPrivate ? '🔒 ' : isStaff ? '👥 ' : ''}${new Date(sl.datetime).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}${sl.apptType ? ' · ' + sl.apptType : ''}
                    </div>
                    <div style="font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;margin-top:1px;">
                      ${name}${isStaff && (sl.status==='anfrage'||sl.type==='anfrage') ? ' <span style=\"font-size:10px;color:#8b5cf6;opacity:0.85;\">(Anfrage)</span>' : ''}
                    </div>
                  </div>
                  ${!isPrivate ? `<button class="slot-del" onclick="event.stopPropagation();deleteCallSlot('${sl.id}')" style="
                    display:none;position:absolute;top:3px;right:3px;
                    background:rgba(239,68,68,0.15);border:none;border-radius:4px;
                    color:#ef4444;cursor:pointer;padding:2px 5px;font-size:12px;
                    align-items:center;justify-content:center;
                  " title="Termin löschen"><i class="ti ti-trash"></i></button>` : ''}
                </div>`;
              }).join('')}
              ${privateSlotsHere.map(sl => {
                // Private Termine: amber/gold, Schloss-Icon, kein Kontakt-Link
                const name = sl.bookedBy || sl.vorname || '?';
                const isAnfrage = sl.status === 'anfrage' || sl.type === 'anfrage';
                const color = '#f59e0b'; // amber – immer, egal ob anfrage oder bestätigt
                const slDate = new Date(sl.datetime);
                const slMin = slDate.getHours() * 60 + slDate.getMinutes();
                const dur = sl.apptDuration || 60;
                const slotCount = Math.max(1, dur / 30);
                const heightPx = slotCount * ROW_HEIGHT - 4;
                const offsetPx = ((slMin - slotMin) / 30) * ROW_HEIGHT;
                return `
                <div title="🔒 ${name}${sl.apptType ? ' · ' + sl.apptType : ''}${isAnfrage ? ' (Anfrage)' : ''}" style="
                  position:absolute;
                  top:${offsetPx + 2}px;
                  left:3px;right:3px;
                  height:${heightPx}px;
                  background:${isAnfrage ? 'rgba(245,158,11,0.1)' : 'rgba(245,158,11,0.18)'};
                  border-left:3px solid ${color};
                  border-style:${isAnfrage ? 'dashed' : 'solid'};
                  border-radius:6px;
                  padding:3px 6px;
                  overflow:hidden;
                  z-index:2;
                  transition:opacity .15s;
                  box-shadow:0 1px 4px rgba(0,0,0,0.12);
                " onmouseover="this.style.opacity='.85';this.querySelector('.priv-slot-del')&&(this.querySelector('.priv-slot-del').style.display='flex')" onmouseout="this.style.opacity='1';this.querySelector('.priv-slot-del')&&(this.querySelector('.priv-slot-del').style.display='none')">
                  <div style="min-width:0;">
                    <div style="font-size:11px;font-weight:700;color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                      🔒 ${new Date(sl.datetime).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}${sl.apptType ? ' · ' + sl.apptType : ''}
                    </div>
                    <div style="font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;margin-top:1px;">
                      ${name}${isAnfrage ? ' <span style="font-size:10px;color:var(--amber);opacity:0.8;">(Anfrage)</span>' : ''}
                    </div>
                  </div>
                  <button class="priv-slot-del" onclick="event.stopPropagation();deletePrivateSlotFromCal('${sl.id}')" style="
                    display:none;position:absolute;top:3px;right:3px;
                    background:rgba(239,68,68,0.15);border:none;border-radius:4px;
                    color:#ef4444;cursor:pointer;padding:2px 5px;font-size:12px;
                    align-items:center;justify-content:center;
                  " title="Privaten Termin löschen"><i class="ti ti-trash"></i></button>
                </div>`;
              }).join('')}
              ${inWorkHours && !inBreak && !slotsHere.length && !privateSlotsHere.length ? `
              <div onclick="openCallSlotModalForDate('${clickIso}')" style="
                position:absolute;inset:1px 2px;border-radius:4px;cursor:pointer;opacity:0;
                background:var(--accent);transition:opacity .12s;
                display:flex;align-items:center;justify-content:center;
              " onmouseover="this.style.opacity='.08'" onmouseout="this.style.opacity='0'" title="${timeLabel} – Termin anlegen">
              </div>` : ''}
            </div>`;
          }).join('');

          return timeLabelCell + dayCells;
        }).join('')}
      </div>
    </div>

    <!-- Legend -->
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:16px;padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:12px;align-items:center;">
      <span style="font-size:13px;color:var(--text3);font-weight:600;">Legende:</span>
      ${(s.apptTypes||[]).map(t => `<span style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text2);">
        <span style="width:12px;height:12px;border-radius:4px;background:${t.color};display:inline-block;"></span>${t.name}
      </span>`).join('')}
      <span style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text2);">
        <span style="width:12px;height:12px;border-radius:4px;background:var(--accent);display:inline-block;"></span>Fix
      </span>
      <span style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text2);">
        <span style="width:12px;height:12px;border-radius:4px;background:var(--amber);display:inline-block;"></span>Flexibel
      </span>
      <span style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text2);">
        <span style="width:12px;height:12px;border-radius:4px;background:#f59e0b;display:inline-block;"></span>🔒 Privat
      </span>
      <span style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text2);">
        <span style="width:12px;height:12px;border-radius:4px;background:#8b5cf6;display:inline-block;"></span>👥 Mitarbeiter
      </span>
      <span style="margin-left:auto;font-size:13px;">
        <button onclick="navigate('settings')" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:13px;padding:0;"><i class="ti ti-settings" style="font-size:13px;"></i> Verfügbarkeit & Terminarten</button>
      </span>
    </div>
  `;
}

// ============================================================
// CALL SLOT MODAL
// ============================================================
// ── Booking-Modal State ──
let _csApptTypes = [];
let _csSelectedAppt = null;
let _csSelectedDate = null;
let _csSelectedTime = null;
let _csCalYear, _csCalMonth;
let _csTakenSlots = [];
const _csPad = n => String(n).padStart(2,'0');
const _csMonths = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const _csDays   = ['Mo','Di','Mi','Do','Fr','Sa','So'];

function _csGoStep(n) {
  [1,2,3].forEach(i => {
    const el = document.getElementById(`cs_step${i}`);
    if (el) el.style.display = i === n ? 'block' : 'none';
  });
}

function _csGetSettings() {
  return JSON.parse(localStorage.getItem('crmSettings') || '{}');
}

// Resolve duration for a callSlot — uses apptDuration if set,
// otherwise looks up the apptType name in settings, falls back to 30
function _csResolveDuration(sl) {
  if (sl.apptDuration && sl.apptDuration > 0) return sl.apptDuration;
  if (sl.apptType) {
    const cfg = _csGetSettings();
    const found = (cfg.apptTypes || []).find(t => t.name === sl.apptType);
    if (found && found.duration) return found.duration;
  }
  return 30;
}

function _csGetDayConfig(jsDay) {
  const cfg = _csGetSettings();
  // Keys in dayConfigs are stored as strings when JSON-serialized
  return (cfg.dayConfigs || {})[String(jsDay)] || (cfg.dayConfigs || {})[jsDay] || null;
}

function _csIsDayAvail(date) {
  const dc = _csGetDayConfig(date.getDay());
  if (!dc || !dc.enabled) return false;
  const cfg = _csGetSettings();
  const ds = date.getFullYear() + '-' + _csPad(date.getMonth()+1) + '-' + _csPad(date.getDate());
  if ((cfg.blockedDates || []).includes(ds)) return false;
  return true;
}

// Prüft ob ein Tag mindestens einen freien Slot hat (berücksichtigt Dauer + bestehende Termine)
function _csDayHasFreeSlots(date) {
  const dc = _csGetDayConfig(date.getDay());
  if (!dc) return false;
  const dur = _csSelectedAppt?.duration || 30;
  const [sh, sm] = dc.start.split(':').map(Number);
  const [eh, em] = dc.end.split(':').map(Number);
  const dayStartMin = sh*60+sm, dayEndMin = eh*60+em;
  let brkS = Infinity, brkE = -Infinity;
  if (dc.breakStart && dc.breakEnd) {
    const [bsh,bsm] = dc.breakStart.split(':').map(Number);
    const [beh,bem] = dc.breakEnd.split(':').map(Number);
    brkS = bsh*60+bsm; brkE = beh*60+bem;
  }
  const now = new Date();
  for (let t = dayStartMin; t + dur <= dayEndMin; t += 30) {
    const apptEnd = t + dur;
    if (dc.breakStart && dc.breakEnd && t < brkE && apptEnd > brkS) continue;
    const slotH = Math.floor(t/60), slotM = t%60;
    const slotDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), slotH, slotM);
    if (slotDate <= now) continue;
    if (_csIsSlotFree(slotDate, dur)) return true;
  }
  return false;
}

function _csRenderCal() {
  const grid = document.getElementById('cs_calGrid');
  if (!grid) return;
  document.getElementById('cs_calTitle').textContent = `${_csMonths[_csCalMonth]} ${_csCalYear}`;
  grid.innerHTML = '';
  _csDays.forEach(d => {
    const h = document.createElement('div');
    h.className = 'cs-cal-day header'; h.textContent = d; grid.appendChild(h);
  });
  const today = new Date(); today.setHours(0,0,0,0);
  const firstDow = new Date(_csCalYear, _csCalMonth, 1).getDay();
  const blanks = firstDow === 0 ? 6 : firstDow - 1;
  const daysInMonth = new Date(_csCalYear, _csCalMonth + 1, 0).getDate();
  for (let b = 0; b < blanks; b++) {
    const el = document.createElement('div'); el.className = 'cs-cal-day empty'; grid.appendChild(el);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(_csCalYear, _csCalMonth, d);
    const el = document.createElement('div');
    el.className = 'cs-cal-day';
    el.textContent = d;
    const isPast  = date < today;
    const avail   = !isPast && _csIsDayAvail(date) && _csDayHasFreeSlots(date);
    const isSel   = _csSelectedDate && _csSelectedDate.y === _csCalYear && _csSelectedDate.m === _csCalMonth && _csSelectedDate.d === d;
    if (isPast || !avail) el.classList.add(isPast ? 'past' : 'unavail');
    else el.classList.add('free');
    if (isSel) { el.classList.remove('free'); el.classList.add('selected'); }
    if (avail) el.addEventListener('click', () => _csSelectDay(_csCalYear, _csCalMonth, d));
    grid.appendChild(el);
  }
}

function _csSelectDay(y, m, d) {
  _csSelectedDate = {y, m, d};
  _csSelectedTime = null;
  document.getElementById('cs_step2Next').disabled = true;
  _csRenderCal();
  _csRenderTimeSlots(y, m, d);
  document.getElementById('cs_timeSection').style.display = 'block';
}

function _csRenderTimeSlots(y, m, d) {
  const grid = document.getElementById('cs_timeGrid');
  const noMsg = document.getElementById('cs_noTimesMsg');
  grid.innerHTML = ''; noMsg.style.display = 'none';
  const dc = _csGetDayConfig(new Date(y, m, d).getDay());
  const dur = _csSelectedAppt?.duration || 30;
  if (!dc) { noMsg.style.display = 'block'; return; }

  const [sh, sm] = dc.start.split(':').map(Number);
  const [eh, em] = dc.end.split(':').map(Number);
  const dayStartMin = sh*60+sm;
  const dayEndMin   = eh*60+em;

  let brkS = Infinity, brkE = -Infinity;
  if (dc.breakStart && dc.breakEnd) {
    const [bsh,bsm] = dc.breakStart.split(':').map(Number);
    const [beh,bem] = dc.breakEnd.split(':').map(Number);
    brkS = bsh*60+bsm; brkE = beh*60+bem;
  }

  const nowDate = new Date();
  const slots = [];

  // Only offer slots where the full duration fits within the day AND no break overlap
  for (let t = dayStartMin; t + dur <= dayEndMin; t += 30) {
    // Skip if any minute of the new appointment falls in the break
    const apptEnd = t + dur;
    const crossesBreak = dc.breakStart && dc.breakEnd && t < brkE && apptEnd > brkS;
    if (crossesBreak) continue;

    const slotH = Math.floor(t/60), slotM = t%60;
    const timeStr = _csPad(slotH) + ':' + _csPad(slotM);
    const slotDate = new Date(y, m, d, slotH, slotM);

    // Skip past slots
    if (slotDate <= nowDate) continue;

    // Check: does this new slot [slotDate, slotDate+dur) overlap any existing appointment?
    const isFree = _csIsSlotFree(slotDate, dur);
    slots.push({ timeStr, isFree });
  }

  document.getElementById('cs_timeSectionTitle').textContent =
    'Uhrzeit – ' + new Date(y,m,d).toLocaleDateString('de-DE',{weekday:'long',day:'2-digit',month:'long'});
  if (slots.length === 0) { noMsg.style.display = 'block'; return; }

  slots.forEach(sl => {
    const btn = document.createElement('div');
    btn.className = 'cs-time-slot' + (sl.isFree ? '' : ' taken');
    btn.textContent = sl.timeStr + ' Uhr';
    if (sl.isFree) {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.cs-time-slot').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        _csSelectedTime = sl.timeStr;
        document.getElementById('cs_step2Next').disabled = false;
      });
    }
    grid.appendChild(btn);
  });
}

function _csBuildSummary() {
  const {y, m, d} = _csSelectedDate;
  const dateStr = new Date(y, m, d).toLocaleDateString('de-DE', {weekday:'long', day:'2-digit', month:'long', year:'numeric'});
  const contact = contacts.find(c => c.id === document.getElementById('cs_contact').value);
  const name = contact ? `${contact.vorname} ${contact.nachname}` : '—';
  document.getElementById('cs_summary').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;">
      <div style="display:flex;gap:8px;"><span style="color:var(--text3);min-width:90px;font-size:13px;">Kontakt</span><span style="font-weight:500;">${name}</span></div>
      <div style="display:flex;gap:8px;"><span style="color:var(--text3);min-width:90px;font-size:13px;">Terminart</span><span style="font-weight:500;color:${_csSelectedAppt.color}">${_csSelectedAppt.name} · ${_csSelectedAppt.duration} Min.</span></div>
      <div style="display:flex;gap:8px;"><span style="color:var(--text3);min-width:90px;font-size:13px;">Datum</span><span style="font-weight:500;">${dateStr}</span></div>
      <div style="display:flex;gap:8px;"><span style="color:var(--text3);min-width:90px;font-size:13px;">Uhrzeit</span><span style="font-weight:500;">${_csSelectedTime} Uhr</span></div>
    </div>
  `;
  // Sync hidden inputs for app.js saveCallSlot handler
  const iso = `${y}-${_csPad(m+1)}-${_csPad(d)}T${_csSelectedTime}`;
  document.getElementById('cs_datetime').value = iso;
  // Sync hidden select
  const apptSel = document.getElementById('cs_appttype');
  apptSel.innerHTML = `<option value="${_csSelectedAppt.name}" data-duration="${_csSelectedAppt.duration}" data-color="${_csSelectedAppt.color}" selected>${_csSelectedAppt.name}</option>`;
}

// _csTakenSlots = array of {start: Date, end: Date} für alle belegten Zeiträume
// Quellen: Firebase callSlots + Google Calendar Events
function _csLoadTakenSlots() {
  try {
    _csTakenSlots = [];
    const horizon = new Date(Date.now() + 90 * 86400000);

    // ── Quelle 1: Firebase callSlots ──────────────────────
    callSlots.forEach(sl => {
      if (!sl.datetime) return;
      const start = new Date(sl.datetime);
      if (isNaN(start) || start > horizon) return;
      const dur = _csResolveDuration(sl);
      const end = new Date(start.getTime() + dur * 60000);
      _csTakenSlots.push({ start, end });
    });

    // ── Quelle 2: Google Calendar Events ──────────────────
    (googleCalendarEvents || []).forEach(ev => {
      if (!ev.datetime) return;

      // Ganztägige Events (kein 'T' im Datum)
      if (!ev.datetime.includes('T')) {
        const dayStart = new Date(ev.datetime + 'T00:00:00');
        const dayEnd   = ev.end && !ev.end.includes('T')
          ? new Date(ev.end + 'T00:00:00')
          : new Date(dayStart.getTime() + 86400000);
        if (dayStart > horizon) return;
        _csTakenSlots.push({ start: dayStart, end: dayEnd });
        return;
      }

      // Timed Events
      const start = new Date(ev.datetime);
      if (isNaN(start) || start > horizon) return;
      const end = ev.end
        ? new Date(ev.end)
        : new Date(start.getTime() + 30 * 60000);
      if (isNaN(end) || end <= start) return;
      _csTakenSlots.push({ start, end });
    });

  } catch(e) {
    console.warn('_csLoadTakenSlots Fehler:', e);
    _csTakenSlots = [];
  }
}

// Check if a proposed slot [slotStart, slotStart+newDurMin) overlaps any existing appointment
// Lädt immer frisch aus callSlots + googleCalendarEvents (kein veralteter Cache)
function _csIsSlotFree(slotStart, newDurMin) {
  const slotEnd = new Date(slotStart.getTime() + newDurMin * 60000);
  const taken = _csBuildTakenList();
  return !taken.some(t => slotStart < t.end && slotEnd > t.start);
}

// Baut die aktuelle Liste belegter Zeiträume live aus beiden Quellen
function _csBuildTakenList() {
  const result = [];
  const horizon = new Date(Date.now() + 90 * 86400000);

  // Quelle 1: Firebase callSlots
  (callSlots || []).forEach(sl => {
    if (!sl.datetime) return;
    const start = new Date(sl.datetime);
    if (isNaN(start) || start > horizon) return;
    const dur = _csResolveDuration(sl);
    result.push({ start, end: new Date(start.getTime() + dur * 60000) });
  });

  // Quelle 2: Google Calendar Events
  (googleCalendarEvents || []).forEach(ev => {
    if (!ev.datetime) return;
    // Ganztägige Events
    if (!ev.datetime.includes('T')) {
      const dayStart = new Date(ev.datetime + 'T00:00:00');
      const dayEnd   = (ev.end && !ev.end.includes('T'))
        ? new Date(ev.end + 'T00:00:00')
        : new Date(dayStart.getTime() + 86400000);
      if (!isNaN(dayStart) && dayStart <= horizon) result.push({ start: dayStart, end: dayEnd });
      return;
    }
    // Timed Events
    const start = new Date(ev.datetime);
    if (isNaN(start) || start > horizon) return;
    const end = ev.end ? new Date(ev.end) : new Date(start.getTime() + 30 * 60000);
    if (!isNaN(end) && end > start) result.push({ start, end });
  });

  return result;
}

window.openCallSlotModal = function(preContactId = null) {
  const cfg = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  _csApptTypes = cfg.apptTypes || [
    { name:'Erstgespräch', color:'#3b82f6', duration:30 },
    { name:'Beratungstermin', color:'#a78bfa', duration:60 },
    { name:'Folgegespräch', color:'#22c55e', duration:20 },
  ];
  _csSelectedAppt = null;
  _csSelectedDate = null;
  _csSelectedTime = null;

  // Populate contact dropdown
  const sel = document.getElementById('cs_contact');
  sel.innerHTML = contacts.map(c => `<option value="${c.id}" ${c.id === preContactId ? 'selected' : ''}>${c.vorname} ${c.nachname}</option>`).join('');

  // Build appt type pills
  const pillWrap = document.getElementById('cs_appttype_pills');
  pillWrap.innerHTML = '';
  _csApptTypes.forEach(t => {
    const pill = document.createElement('div');
    pill.className = 'cs-appt-pill';
    pill.style.color = t.color;
    pill.innerHTML = `<span style="width:9px;height:9px;border-radius:3px;background:${t.color};display:inline-block;flex-shrink:0;"></span><span>${t.name}</span><span style="font-size:11px;opacity:.65;">· ${t.duration} Min.</span>`;
    pill.addEventListener('click', () => {
      document.querySelectorAll('.cs-appt-pill').forEach(p => p.classList.remove('selected'));
      pill.classList.add('selected');
      _csSelectedAppt = t;
    });
    pillWrap.appendChild(pill);
  });
  // Auto-select first
  pillWrap.querySelector('.cs-appt-pill')?.click();

  // Pre-check email options
  document.getElementById('cs_confirm').checked = cfg.autoConfirm || false;
  document.getElementById('cs_reminder').checked = cfg.autoReminder || false;
  document.getElementById('cs_note').value = '';

  _csGoStep(1);
  document.getElementById('callSlotModal').classList.add('open');

  // Load taken slots from memory
  _csLoadTakenSlots();
};

window.openCallSlotModalForDate = function(isoDate) {
  openCallSlotModal();
  // Will be overridden after user picks in calendar — just open normally
};

// Step 1 → 2
document.getElementById('cs_step1Next').addEventListener('click', () => {
  if (!_csSelectedAppt) { alert('Bitte eine Terminart wählen.'); return; }
  const now2 = new Date();
  _csCalYear = now2.getFullYear(); _csCalMonth = now2.getMonth();
  _csRenderCal();
  document.getElementById('cs_timeSection').style.display = 'none';
  document.getElementById('cs_step2Next').disabled = true;
  _csGoStep(2);
});

document.getElementById('cs_calPrev').addEventListener('click', () => {
  const now2 = new Date();
  if (_csCalYear === now2.getFullYear() && _csCalMonth === now2.getMonth()) return;
  _csCalMonth--; if (_csCalMonth < 0) { _csCalMonth = 11; _csCalYear--; }
  _csRenderCal();
});
document.getElementById('cs_calNext').addEventListener('click', () => {
  _csCalMonth++; if (_csCalMonth > 11) { _csCalMonth = 0; _csCalYear++; }
  _csRenderCal();
});

// Step 2 → 3
document.getElementById('cs_step2Next').addEventListener('click', () => {
  if (!_csSelectedDate || !_csSelectedTime) return;
  _csBuildSummary();
  _csGoStep(3);
});

// Step 2 ← back
document.getElementById('cs_step2Back').addEventListener('click', () => _csGoStep(1));

// Step 3 ← back
document.getElementById('cs_step3Back').addEventListener('click', () => _csGoStep(2));

document.getElementById('saveCallSlot').addEventListener('click', async () => {
  const apptSel = document.getElementById('cs_appttype');
  // Prefer _csSelectedAppt (set by booking UI) over hidden select fallback
  const apptTypeName = _csSelectedAppt?.name || apptSel.value;
  const apptDuration = _csSelectedAppt?.duration || parseInt(apptSel.selectedOptions[0]?.dataset?.duration || '30');
  const apptColor = _csSelectedAppt?.color || apptSel.selectedOptions[0]?.dataset?.color || '';
  const note = document.getElementById('cs_note').value.trim();
  const contactId = document.getElementById('cs_contact').value;

  const data = {
    contactId,
    datetime: document.getElementById('cs_datetime').value,
    type: document.getElementById('cs_type').value,
    apptType: apptTypeName,
    apptDuration,
    apptColor,
    note,
    sendConfirm: document.getElementById('cs_confirm').checked,
    sendReminder: document.getElementById('cs_reminder').checked,
  };

  // Add history entry to contact
  if (contactId && note) {
    const contact = contacts.find(c => c.id === contactId);
    if (contact) {
      const histEntry = {
        type: 'termin',
        datetime: data.datetime,
        note: `[${apptTypeName || 'Termin'}] ${note}`,
        followup: null,
      };
      const updatedHistory = [...(contact.history || []), histEntry];
      // Also append to notizen
      const existingNotizen = contact.notizen || '';
      const noteAppend = `\n[${new Date(data.datetime).toLocaleDateString('de-DE')} ${apptTypeName || 'Termin'}] ${note}`.trim();
      const updatedNotizen = existingNotizen ? existingNotizen + '\n' + noteAppend : noteAppend;
      try {
        await updateDoc(doc(db, 'contacts', contactId), { history: updatedHistory, notizen: updatedNotizen });
      } catch {
        const idx = contacts.findIndex(c => c.id === contactId);
        if (idx !== -1) {
          contacts[idx].history = updatedHistory;
          contacts[idx].notizen = updatedNotizen;
        }
      }
    }
  }

  const contactForSync = contacts.find(c => c.id === contactId);

  // ── Kollisionsprüfung ──────────────────────────────────
  const newStart = new Date(data.datetime).getTime();
  const newEnd   = newStart + apptDuration * 60000;
  const conflict = callSlots.find(sl => {
    const exStart = new Date(sl.datetime).getTime();
    const exEnd   = exStart + (sl.apptDuration || 30) * 60000;
    return newStart < exEnd && newEnd > exStart;
  });
  if (conflict) {
    const conflictTime = new Date(conflict.datetime).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const conflictContact = contacts.find(c => c.id === conflict.contactId);
    const nameStr = conflictContact ? ` (${conflictContact.vorname} ${conflictContact.nachname})` : '';
    toast(`⚠️ Zeitkonflikt: Überschneidung mit Termin am ${conflictTime}${nameStr}.`, 'error');
    return;
  }
  // ──────────────────────────────────────────────────────

  try {
    const newSlotRef = await addDoc(collection(db, 'callSlots'), data);
    data.id = newSlotRef.id;
    // Sofort ins lokale Array aufnehmen damit Kollisionsprüfung aktuell bleibt
    callSlots.push({ id: newSlotRef.id, ...data });
    _csLoadTakenSlots();
    toast(`Termin eingeplant${apptTypeName ? ': ' + apptTypeName : ''}!`);
    await syncToGoogleCalendar(data, contactForSync);
  } catch {
    callSlots.push({ id: 'local_' + Date.now(), ...data });
    _csLoadTakenSlots();
    toast('Eingeplant (offline).');
    renderCalendar();
  }

  document.getElementById('callSlotModal').classList.remove('open');

  // E-Mail Auswahl Dialog
  showEmailDialog(contactForSync, data);
});

// ============================================================
// E-MAIL AUSWAHL DIALOG – erscheint nach jedem Termin
// ============================================================
function showEmailDialog(contact, slotData) {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const hasEmail = !!contact?.email;

  const dt = new Date(slotData.datetime);
  const datum = dt.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const uhrzeit = dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  document.getElementById('emailDialog')?.remove();

  const dlg = document.createElement('div');
  dlg.id = 'emailDialog';
  dlg.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:500;
    display:flex;align-items:center;justify-content:center;padding:20px;
  `;

  dlg.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:18px;
      padding:28px 24px;width:100%;max-width:420px;animation:modalIn .2s ease;">

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <div style="width:36px;height:36px;border-radius:10px;background:rgba(167,139,250,0.15);
          display:flex;align-items:center;justify-content:center;font-size:18px;">📧</div>
        <div>
          <div style="font-size:15px;font-weight:700;">E-Mails versenden?</div>
          <div style="font-size:12px;color:var(--text3);">Termin: ${datum} · ${uhrzeit} Uhr</div>
        </div>
      </div>

      ${!hasEmail ? `
        <div style="margin:14px 0;padding:10px 12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;font-size:13px;color:var(--amber);">
          <i class="ti ti-alert-circle"></i> Kein E-Mail beim Kontakt hinterlegt – E-Mail-Versand nicht möglich.
        </div>
      ` : `
        <div style="font-size:13px;color:var(--text2);margin:10px 0 16px;">
          An: <strong>${contact?.vorname || ''} ${contact?.nachname || ''}</strong>
          <span style="color:var(--text3);"> · ${contact.email}</span>
        </div>
      `}

      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">

        <!-- Terminbestätigung -->
        <label style="display:flex;align-items:flex-start;gap:12px;cursor:${hasEmail?'pointer':'not-allowed'};
          background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;
          opacity:${hasEmail?'1':'0.5'};">
          <input type="checkbox" id="ed_confirm" ${s.autoConfirm && hasEmail ? 'checked' : ''} ${!hasEmail ? 'disabled' : ''}
            style="margin-top:2px;width:16px;height:16px;cursor:${hasEmail?'pointer':'not-allowed'};" />
          <div>
            <div style="font-weight:600;font-size:13px;">📬 Terminbestätigung</div>
            <div style="font-size:12px;color:var(--text3);margin-top:2px;">Wird sofort über Gmail gesendet – inkl. Kalender-Datei (.ics) zum Eintragen</div>
          </div>
        </label>

        <!-- Terminerinnerung -->
        <label style="display:flex;align-items:flex-start;gap:12px;cursor:${hasEmail?'pointer':'not-allowed'};
          background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;
          opacity:${hasEmail?'1':'0.5'};">
          <input type="checkbox" id="ed_reminder" ${s.autoReminder && hasEmail ? 'checked' : ''} ${!hasEmail ? 'disabled' : ''}
            style="margin-top:2px;width:16px;height:16px;cursor:${hasEmail?'pointer':'not-allowed'};" />
          <div>
            <div style="font-weight:600;font-size:13px;">🔔 Terminerinnerung</div>
            <div style="font-size:12px;color:var(--text3);margin-top:2px;">Wird am Termintag um 09:00 Uhr gesendet (gespeichert für automatischen Versand)</div>
          </div>
        </label>

        <!-- Nur .ics -->
        <label style="display:flex;align-items:flex-start;gap:12px;cursor:${hasEmail?'pointer':'not-allowed'};
          background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;
          opacity:${hasEmail?'1':'0.5'};">
          <input type="checkbox" id="ed_ics" ${hasEmail ? 'checked' : ''} ${!hasEmail ? 'disabled' : ''}
            style="margin-top:2px;width:16px;height:16px;cursor:${hasEmail?'pointer':'not-allowed'};" />
          <div>
            <div style="font-weight:600;font-size:13px;">📅 Kalender-Einladung (.ics)</div>
            <div style="font-size:12px;color:var(--text3);margin-top:2px;">Kalender-Datei als Anhang – Empfänger trägt Termin mit einem Klick ein</div>
          </div>
        </label>

      </div>

      <div style="display:flex;gap:8px;">
        <button id="ed_skip" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border2);
          background:none;color:var(--text2);cursor:pointer;font-size:14px;font-family:inherit;">
          Überspringen
        </button>
        <button id="ed_send" style="flex:2;padding:10px;border-radius:10px;border:none;
          background:var(--purple);color:#fff;cursor:pointer;font-size:14px;font-weight:600;font-family:inherit;
          ${!hasEmail ? 'opacity:0.4;cursor:not-allowed;' : ''}">
          <i class="ti ti-send"></i> Senden
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(dlg);

  document.getElementById('ed_skip').addEventListener('click', () => dlg.remove());

  document.getElementById('ed_send').addEventListener('click', async () => {
    if (!hasEmail) { dlg.remove(); return; }

    const sendConfirm = document.getElementById('ed_confirm').checked;
    const sendReminder = document.getElementById('ed_reminder').checked;
    const sendIcs = document.getElementById('ed_ics').checked;

    dlg.remove();

    // Terminbestätigung (enthält immer .ics wenn sendIcs auch an)
    if (sendConfirm) {
      await sendConfirmationEmail(contact, { ...slotData, withIcs: sendIcs });
    } else if (sendIcs && !sendConfirm) {
      // Nur .ics ohne Bestätigungstext
      await sendCalendarInviteOnly(contact, slotData);
    }

    // Erinnerung als Flag in Firestore speichern
    if (sendReminder) {
      try {
        const q = await getDocs(query(collection(db, 'callSlots'),
          orderBy('datetime', 'desc')));
        // Neuesten Slot dieses Kontakts updaten
        const slot = q.docs.find(d => d.data().contactId === slotData.contactId &&
          d.data().datetime === slotData.datetime);
        if (slot) {
          await updateDoc(doc(db, 'callSlots', slot.id), { sendReminder: true });
        }
      } catch {}
      toast('🔔 Erinnerung wird am Termintag um 09:00 Uhr versendet.', 'success');
    }
  });
}

// Nur Kalender-Einladung senden (ohne Bestätigungstext)
async function sendCalendarInviteOnly(contact, slotData) {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const from = s.gmailSender || 'nawin.telis@gmail.com';
  const dt = new Date(slotData.datetime);
  const datum = dt.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const uhrzeit = dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  const subject = `Kalender-Einladung: ${slotData.apptType || 'Termin'} am ${datum}`;
  const htmlBody = `Hallo ${contact.vorname},<br><br>im Anhang findest du die Kalender-Einladung für unseren Termin am <strong>${datum} um ${uhrzeit} Uhr</strong>.<br><br>${(s.emailSig||'').replace(/\n/g,'<br>')}`;
  const icsContent = generateICS(contact, slotData);

  const token = await getGmailToken();
  if (!token) { toast('⚠️ Gmail-Login fehlgeschlagen.', 'error'); return; }

  const rawMessage = buildGmailMessage(contact.email, `${contact.vorname} ${contact.nachname}`, from, subject, htmlBody, icsContent);

  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rawMessage }),
    });
    if (res.ok) toast(`📅 Kalender-Einladung an ${contact.vorname} gesendet!`, 'success');
    else toast('❌ Fehler beim Senden der Kalender-Einladung.', 'error');
  } catch { toast('❌ Verbindungsfehler.', 'error'); }
}

window.deleteCallSlot = async function(id) {
  const slot = callSlots.find(s => s.id === id);
  const hasGcal = slot?.gcalEventIds && Object.keys(slot.gcalEventIds).length > 0;

  if (!confirm('Termin wirklich löschen?' + (hasGcal ? '\n\nWird auch aus Google Kalender entfernt.' : ''))) return;

  if (hasGcal) {
    toast('Wird aus Google Kalender gelöscht…');
    const deleted = await deleteGCalEvents(slot.gcalEventIds);
    if (deleted > 0) {
      const deletedIds = Object.values(slot.gcalEventIds);
      googleCalendarEvents = googleCalendarEvents.filter(e => !deletedIds.includes(e.id));
    }
  }

  try {
    await deleteDoc(doc(db, 'callSlots', id));
    toast(hasGcal ? '✅ Überall gelöscht!' : 'Termin gelöscht.', hasGcal ? 'success' : undefined);
    if (hasGcal) setTimeout(() => loadGoogleCalendarEvents(), 1500);
  } catch {
    callSlots = callSlots.filter(s => s.id !== id);
    toast('Gelöscht (offline).');
    renderCalendar();
  }
};

async function deleteGCalEvents(gcalEventIds) {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const calendars = [
    { id: s.gcalId,  email: s.gcalId  },
    { id: s.gcalId2, email: s.gcalId2 },
  ].filter(c => c.id);

  let deleted = 0;
  for (const cal of calendars) {
    const eventId = gcalEventIds[cal.id];
    if (!eventId) continue;
    const token = await getGCalOAuthToken(cal.email);
    if (!token) continue;
    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events/${eventId}`,
        { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (res.ok || res.status === 410) deleted++; // 410 = already deleted
    } catch(e) { console.warn('GCal delete error:', e.message); }
  }
  return deleted;
}

async function showDeleteSlotDialog(id, slot) {
  document.getElementById('deleteSlotDialog')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'deleteSlotDialog';
  dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:600;display:flex;align-items:center;justify-content:center;padding:20px;';
  dlg.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:24px;width:100%;max-width:400px;animation:modalIn .2s ease;">
      <div style="font-size:18px;font-weight:700;margin-bottom:8px;">🗑️ Termin löschen</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:20px;">
        Dieser Termin ist auch in Google Kalender eingetragen. Wie möchtest du ihn löschen?
      </p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button id="dsd_both" style="padding:11px 14px;border-radius:10px;border:none;background:var(--red);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;text-align:left;">
          🗑️ Überall löschen <span style="font-size:12px;font-weight:400;opacity:0.85;">– Lead Tracker + Google Kalender</span>
        </button>
        <button id="dsd_tracker" style="padding:11px 14px;border-radius:10px;border:1px solid var(--border2);background:none;color:var(--text);font-size:14px;cursor:pointer;font-family:inherit;text-align:left;">
          📋 Nur im Lead Tracker löschen <span style="font-size:12px;opacity:0.6;">– Google Kalender bleibt</span>
        </button>
        <button id="dsd_cancel" style="padding:9px 14px;border-radius:10px;border:1px solid var(--border2);background:none;color:var(--text3);font-size:13px;cursor:pointer;font-family:inherit;">
          Abbrechen
        </button>
      </div>
    </div>`;
  document.body.appendChild(dlg);

  document.getElementById('dsd_cancel').onclick = () => dlg.remove();

  document.getElementById('dsd_tracker').onclick = async () => {
    dlg.remove();
    try {
      await deleteDoc(doc(db, 'callSlots', id));
      toast('Termin im Lead Tracker gelöscht.');
    } catch {
      callSlots = callSlots.filter(s => s.id !== id);
      renderCalendar();
      toast('Gelöscht (offline).');
    }
  };

  document.getElementById('dsd_both').onclick = async () => {
    dlg.remove();
    toast('Wird aus Google Kalender gelöscht...');
    const deleted = await deleteGCalEvents(slot.gcalEventIds);
    try {
      await deleteDoc(doc(db, 'callSlots', id));
    } catch {
      callSlots = callSlots.filter(s => s.id !== id);
      renderCalendar();
    }
    if (deleted > 0) {
      toast(`✅ Überall gelöscht (${deleted > 1 ? 'beide Kalender' : 'Google Kalender'} + Lead Tracker)!`, 'success');
    } else {
      toast('Lead Tracker gelöscht. Google Kalender-Löschung fehlgeschlagen – bitte manuell entfernen.', 'error');
    }
    setTimeout(() => loadGoogleCalendarEvents(), 1500);
  };
}

document.getElementById('closeCallSlotModal').addEventListener('click', () => document.getElementById('callSlotModal').classList.remove('open'));

// ============================================================
// DELETE CONTACT
// ============================================================
// Einzelnen Google Kalender-Eintrag direkt aus dem Wochenplan löschen
window.deleteGCalEventDirect = async function(eventId, calendarId, calendarLabel) {
  if (!confirm(`"${calendarLabel}"-Eintrag aus Google Kalender löschen?`)) return;
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const calEmail = calendarId;
  const token = await getGCalOAuthToken(calEmail);
  if (!token) { toast('⚠️ Google Login fehlgeschlagen.', 'error'); return; }
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (res.ok || res.status === 410) {
      toast(`✅ Aus ${calendarLabel} gelöscht!`, 'success');
      googleCalendarEvents = googleCalendarEvents.filter(e => e.id !== eventId);
      renderCalendar();
    } else {
      toast('❌ Löschen fehlgeschlagen.', 'error');
    }
  } catch(e) {
    toast('❌ Verbindungsfehler.', 'error');
  }
};

window.deleteContact = async function(id) {
  if (!confirm('Kontakt wirklich löschen?')) return;
  try {
    await deleteDoc(doc(db, 'contacts', id));
    toast('Kontakt gelöscht.');
  } catch {
    contacts = contacts.filter(c => c.id !== id);
    toast('Gelöscht (offline).');
    renderContacts();
  }
};

// ============================================================
// EXPORT PAGE
// ============================================================
function renderExport() {
  const settings = JSON.parse(localStorage.getItem('crmSettings') || '{}');

  document.getElementById('content').innerHTML = `
    <div class="export-section">
      <h3><i class="ti ti-copy" style="margin-right:6px;"></i>Alle Kontakte kopieren</h3>
      <p>Kopiert alle Kontakte als tabellarische Daten – einfach in Monday.com einfügen.</p>
      <button class="btn-primary" id="copyAll"><i class="ti ti-clipboard"></i> In Zwischenablage kopieren</button>
    </div>

    <div class="export-section">
      <h3><i class="ti ti-file-text" style="margin-right:6px;"></i>CSV Export</h3>
      <p>Lädt alle Kontakte als CSV-Datei herunter.</p>
      <button class="btn-primary" id="downloadCsv"><i class="ti ti-download"></i> CSV herunterladen</button>
    </div>

    <div class="export-section">
      <h3><i class="ti ti-brand-monday" style="margin-right:6px;"></i>Monday.com Direktsync</h3>
      <p>
        ${settings.mondayKey ? `<span style="color:var(--green)"><i class="ti ti-check-circle"></i> API-Key hinterlegt</span>` : `<span style="color:var(--amber)"><i class="ti ti-alert-circle"></i> Noch kein API-Key – in den Einstellungen hinterlegen</span>`}
      </p>
      <button class="btn-primary" id="mondaySync" ${!settings.mondayKey ? 'disabled style="opacity:0.5;"' : ''}>
        <i class="ti ti-refresh"></i> Jetzt zu Monday synchronisieren
      </button>
      ${!settings.mondayKey ? `<button class="btn-ghost" style="margin-left:8px;" onclick="navigate('settings')"><i class="ti ti-settings"></i> Einstellungen öffnen</button>` : ''}
    </div>

    <div class="export-section">
      <h3>Vorschau (${contacts.length} Kontakte)</h3>
      <div class="contacts-table-wrap">
        <table class="contacts-table" style="font-size:13px;">
          <thead><tr><th>Name</th><th>Telefon</th><th>E-Mail</th><th>Thema</th><th>Status</th><th>Quelle</th><th>Ort</th></tr></thead>
          <tbody>${contacts.map(c => `<tr>
            <td>${c.vorname} ${c.nachname}</td>
            <td>${c.telefon||''}</td><td>${c.email||''}</td>
            <td>${c.thema||''}</td><td>${c.status||''}</td>
            <td>${c.quelle||''}</td><td>${c.ort||''}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('copyAll').addEventListener('click', () => {
    const header = 'Vorname\tNachname\tTelefon\tE-Mail\tOrt\tThema\tQuelle\tStatus\tNotizen';
    const rows = contacts.map(c => `${c.vorname}\t${c.nachname}\t${c.telefon||''}\t${c.email||''}\t${c.ort||''}\t${c.thema||''}\t${c.quelle||''}\t${c.status||''}\t${c.notizen||''}`);
    navigator.clipboard.writeText([header, ...rows].join('\n'));
    toast('In Zwischenablage kopiert! Jetzt in Monday einfügen.');
  });

  document.getElementById('downloadCsv').addEventListener('click', () => {
    const header = 'Vorname,Nachname,Telefon,E-Mail,Ort,Thema,Quelle,Status,Notizen';
    const rows = contacts.map(c => [c.vorname,c.nachname,c.telefon,c.email,c.ort,c.thema,c.quelle,c.status,c.notizen].map(v => `"${(v||'').replace(/"/g,'""')}"`).join(','));
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `leads_${new Date().toISOString().slice(0,10)}.csv`; a.click();
    toast('CSV wird heruntergeladen.');
  });

  if (settings.mondayKey) {
    document.getElementById('mondaySync').addEventListener('click', () => syncToMonday(settings));
  }
}

async function syncToMonday(settings) {
  if (!settings.mondayKey || !settings.mondayBoardId) {
    toast('Bitte API-Key und Board-ID in den Einstellungen hinterlegen.', 'error'); return;
  }
  toast('Monday.com Sync wird vorbereitet...');
  // Monday GraphQL API call – wird aktiviert sobald API-Key hinterlegt
  // Die Implementierung ist vorbereitet und wartet auf deinen API-Key
}

// ============================================================
// SETTINGS PAGE
// ============================================================
// ── Pufferzeit-Pills Hilfsfunktionen ──
window._setPuffer = function(v) {
  const inp = document.getElementById('s_pufferMinuten');
  if (inp) inp.value = v;
  window._syncPufferPills(v);
};
window._syncPufferPills = function(v) {
  const val = parseInt(v);
  [5,10,15,20,30,45,60].forEach(n => {
    const btn = document.getElementById('pp_' + n);
    if (!btn) return;
    const active = val === n;
    btn.style.borderColor = active ? '#10b981' : 'var(--border2)';
    btn.style.background  = active ? 'rgba(16,185,129,0.15)' : 'transparent';
    btn.style.color       = active ? '#10b981' : 'var(--text2)';
  });
};

function renderSettings() {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');

  // Per-day availability: object keyed by day number (0=So,1=Mo,...,6=Sa)
  const defaultDayConfig = { enabled: false, start: '09:00', end: '18:00', breakStart: '', breakEnd: '' };
  const dayConfigs = s.dayConfigs || {
    1: { enabled: true,  start: '09:00', end: '18:00', breakStart: '', breakEnd: '' },
    2: { enabled: true,  start: '09:00', end: '18:00', breakStart: '', breakEnd: '' },
    3: { enabled: true,  start: '09:00', end: '18:00', breakStart: '', breakEnd: '' },
    4: { enabled: true,  start: '09:00', end: '18:00', breakStart: '', breakEnd: '' },
    5: { enabled: true,  start: '09:00', end: '18:00', breakStart: '', breakEnd: '' },
    6: { enabled: false, start: '09:00', end: '13:00', breakStart: '', breakEnd: '' },
    0: { enabled: false, start: '09:00', end: '13:00', breakStart: '', breakEnd: '' },
  };
  const dayLabels = [{v:1,l:'Montag'},{v:2,l:'Dienstag'},{v:3,l:'Mittwoch'},{v:4,l:'Donnerstag'},{v:5,l:'Freitag'},{v:6,l:'Samstag'},{v:0,l:'Sonntag'}];

  const emailConfirmText = s.emailConfirmText ||
`Hallo {vorname},

hiermit bestätige ich unseren gemeinsamen Termin am {datum} um {uhrzeit} Uhr.

Bei Fragen stehe ich dir gerne zur Verfügung.

{signatur}`;

  const emailReminderText = s.emailReminderText ||
`Hallo {vorname},

nur eine kurze Erinnerung: Heute um {uhrzeit} Uhr haben wir einen Termin.

Ich freue mich auf unser Gespräch!

{signatur}`;

  const emailNotifyText = s.emailNotifyText ||
`Hallo {vorname},

hier sind alle Details zu Ihrem kommenden Termin:

\u{1F4C5} Datum: {datum}
\u{1F550} Uhrzeit: {uhrzeit} Uhr

Ich freue mich auf unser Gespräch!

{signatur}`;

  document.getElementById('content').innerHTML = `

    <!-- ── E-MAIL & BENACHRICHTIGUNGEN ── -->
    <div class="settings-section">
      <h3>E-Mail & Benachrichtigungen</h3>
      <div class="form-grid">
        <div class="field full"><label>Deine E-Mail-Adresse (Absender)</label>
          <input type="email" id="s_myEmail" placeholder="deine@email.de" value="${s.myEmail||''}" />
        </div>
        <div class="field full"><label>E-Mail Signatur <span style="font-weight:400;color:var(--text3);font-size:11px;">(optional – nur wenn kein Outlook/Mailclient)</span></label>
          <textarea id="s_emailSig" rows="3" placeholder="Mit freundlichen Grüßen,&#10;Max Mustermann">${s.emailSig||''}</textarea>
          <div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;">
            <label style="
              display:inline-flex;align-items:center;gap:6px;cursor:pointer;
              background:var(--bg3);border:1px solid var(--border2);color:var(--text2);
              border-radius:8px;padding:6px 12px;font-size:13px;transition:all .15s;
            " title="Bild in Signatur einfügen">
              <i class="ti ti-photo"></i> Bild einfügen
              <input type="file" id="s_sigImageInput" accept="image/*" style="display:none;" />
            </label>
            <span style="font-size:12px;color:var(--text3);">Das Bild wird als <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{bild}</code> eingefügt – du kannst es im Text frei positionieren.</span>
          </div>
          ${s.emailSigImage ? `
          <div style="margin-top:8px;display:flex;align-items:center;gap:10px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;">
            <img src="${s.emailSigImage}" style="max-height:40px;max-width:120px;object-fit:contain;border-radius:4px;" />
            <span style="font-size:12px;color:var(--green);flex:1;"><i class="ti ti-check-circle"></i> Bild gespeichert</span>
            <button id="s_removeSigImage" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:13px;"><i class="ti ti-trash"></i> Entfernen</button>
          </div>` : `<div id="s_sigImagePreview" style="margin-top:8px;"></div>`}
          <p style="font-size:12px;color:var(--text3);margin-top:5px;"><i class="ti ti-info-circle"></i> Wenn du Outlook oder einen anderen E-Mail-Client mit eigener Signatur verwendest, lasse dieses Feld einfach leer – deine Outlook-Signatur wird automatisch angehängt.</p>
        </div>
      </div>
    </div>

    <!-- ── TERMINBENACHRICHTIGUNG ── -->
    <div class="settings-section">
      <h3>📲 Terminbenachrichtigung
        <span style="font-weight:400;font-size:11px;color:var(--purple);background:rgba(139,92,246,0.12);padding:2px 8px;border-radius:10px;margin-left:6px;">geht sofort beim Eintragen raus</span>
      </h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">
        Wird direkt versendet, sobald du einen Termin einträgst – ohne Kalenderanhang.<br/>
        <span style="font-size:12px;color:var(--text3);">Platzhalter: <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{vorname}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{nachname}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{datum}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{uhrzeit}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{signatur}</code></span>
      </p>
      <div class="form-grid">
        <div class="field full"><label>Betreff</label>
          <input type="text" id="s_notifySubject" placeholder="Ihr Termin am {datum}" value="${s.notifySubject||'Ihr Termin am {datum}'}" />
        </div>
        <div class="field full"><label>Nachrichtentext</label>
          <textarea id="s_emailNotifyText" rows="7" style="font-family:'DM Mono',monospace;font-size:13px;">${emailNotifyText}</textarea>
        </div>
      </div>
    </div>

    <!-- ── TERMINBESTÄTIGUNG ── -->
    <div class="settings-section">
      <h3>📧 Terminbestätigung
        <span style="font-weight:400;font-size:11px;color:var(--accent);background:rgba(59,130,246,0.12);padding:2px 8px;border-radius:10px;margin-left:6px;">1 Tag vor dem Termin</span>
      </h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">
        Geht automatisch einen Tag vor dem Termin raus – inklusive .ics-Kalenderdatei im Anhang.<br/>
        <span style="font-size:12px;color:var(--text3);">Platzhalter: <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{vorname}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{nachname}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{datum}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{uhrzeit}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{signatur}</code></span>
      </p>
      <div class="form-grid">
        <div class="field full"><label>Betreff</label>
          <input type="text" id="s_confirmSubject" placeholder="Terminbestätigung – {datum}" value="${s.confirmSubject||'Terminbestätigung – {datum}'}" />
        </div>
        <div class="field full"><label>Nachrichtentext</label>
          <textarea id="s_emailConfirmText" rows="7" style="font-family:'DM Mono',monospace;font-size:13px;">${emailConfirmText}</textarea>
        </div>
      </div>
    </div>

    <!-- ── TERMINERINNERUNG ── -->
    <div class="settings-section">
      <h3>🔔 Terminerinnerung
        <span style="font-weight:400;font-size:11px;color:var(--amber);background:rgba(245,158,11,0.12);padding:2px 8px;border-radius:10px;margin-left:6px;">am Termintag um 09:00 Uhr</span>
      </h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">
        Geht automatisch am Morgen des Termintags um 09:00 Uhr raus.<br/>
        <span style="font-size:12px;color:var(--text3);">Platzhalter: <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{vorname}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{nachname}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{datum}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{uhrzeit}</code> <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{signatur}</code></span>
      </p>
      <div class="form-grid">
        <div class="field full"><label>Betreff</label>
          <input type="text" id="s_reminderSubject" placeholder="Erinnerung: Unser Termin heute um {uhrzeit} Uhr" value="${s.reminderSubject||'Erinnerung: Unser Termin heute um {uhrzeit} Uhr'}" />
        </div>
        <div class="field full"><label>Nachrichtentext</label>
          <textarea id="s_emailReminderText" rows="7" style="font-family:'DM Mono',monospace;font-size:13px;">${emailReminderText}</textarea>
        </div>
      </div>
    </div>

    <!-- ── TERMINARTEN FÜR MANDANTEN ── -->
    <div class="settings-section">
      <h3>🗂️ Terminarten für Mandanten</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">Terminarten für externe Mandanten – erscheinen auf der öffentlichen Buchungsseite und beim normalen Einplanen.</p>
      <div id="apptTypesList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;"></div>
      <button class="btn-ghost" id="addApptType" style="font-size:13px;"><i class="ti ti-plus"></i> Neue Terminart hinzufügen</button>

      <!-- Ersttermin-Dauer für Website-Anfragen -->
      <div style="margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.07);">
        <label style="font-size:12px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:8px;">
          🌐 Ersttermin-Dauer (Website-Anfrage)
        </label>
        <p style="font-size:12px;color:var(--text3);margin-bottom:10px;line-height:1.5;">
          Dauer in Minuten, die beim Termin-Picker auf der öffentlichen Website für einen Ersttermin reserviert wird. Beeinflusst welche Zeitslots als frei angezeigt werden.
        </p>
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="number" id="s_erstterminDuration" min="15" max="180" step="15"
            value="${s.erstterminDuration || 30}"
            style="width:90px;padding:7px 10px;background:var(--surface2);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:var(--text1);font-size:14px;text-align:center;" />
          <span style="font-size:13px;color:var(--text2);">Minuten</span>
        </div>
      </div>
    </div>

    <!-- ── TERMINARTEN FÜR MITARBEITER ── -->
    <div class="settings-section" style="border-left:3px solid #8b5cf6;">
      <h3>👥 Terminarten für Mitarbeiter</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">Terminarten für interne Team-Termine – nur auf dem Mitarbeiter-Buchungslink verfügbar. Diese Termine werden im Wochenplan <strong style="color:#8b5cf6;">lila markiert</strong>.</p>
      <div id="staffApptTypesList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;"></div>
      <button class="btn-ghost" id="addStaffApptType" style="font-size:13px;"><i class="ti ti-plus"></i> Neue Mitarbeiter-Terminart hinzufügen</button>
    </div>

    <!-- ── MOBILITÄT & FAHRZEIT-PRÜFUNG ── -->
    <div class="settings-section" style="border-left:3px solid #10b981;">
      <h3>🚗 Mobilität & Fahrzeitprüfung</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">
        Das System prüft automatisch, ob du einen neuen Termin nach dem vorherigen
        noch rechtzeitig erreichst – inkl. Fahrzeit und Puffer.
      </p>
      <div class="form-grid">
        <div class="field">
          <label>Hauptverkehrsmittel</label>
          <select id="s_verkehrsmittel">
            <option value="auto"    ${s.verkehrsmittel==='auto'   ||!s.verkehrsmittel?'selected':''}>🚗 Auto</option>
            <option value="oepnv"   ${s.verkehrsmittel==='oepnv'  ?'selected':''}>🚆 ÖPNV / Zug</option>
            <option value="fahrrad" ${s.verkehrsmittel==='fahrrad'?'selected':''}>🚲 Fahrrad</option>
            <option value="fuss"    ${s.verkehrsmittel==='fuss'   ?'selected':''}>🚶 Zu Fuß</option>
          </select>
        </div>
        <div class="field">
          <label>Pufferzeit nach Termin</label>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="display:flex;gap:6px;flex-wrap:wrap;" id="puffer_pills">
              ${[5,10,15,20,30,45,60].map(v => {
                const active = (s.pufferMinuten||15) == v;
                return `<button type="button" id="pp_${v}"
                  onclick="window._setPuffer(${v})"
                  style="padding:5px 12px;border-radius:20px;font-size:12px;font-weight:600;
                  cursor:pointer;transition:all .15s;font-family:inherit;
                  border:1.5px solid ${active?'#10b981':'var(--border2)'};
                  background:${active?'rgba(16,185,129,0.15)':'transparent'};
                  color:${active?'#10b981':'var(--text2)'};">
                  ${v} Min.</button>`;
              }).join('')}
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:11px;color:var(--text3);">oder</span>
              <input type="text" inputmode="numeric" pattern="[0-9]*"
                id="s_pufferMinuten"
                value="${s.pufferMinuten !== undefined ? s.pufferMinuten : 15}"
                placeholder="z.B. 25"
                oninput="window._syncPufferPills(this.value)"
                style="width:72px;background:var(--bg2);border:1px solid var(--border2);
                color:var(--text);border-radius:8px;padding:5px 10px;font-size:13px;
                font-family:inherit;outline:none;text-align:center;" />
              <span style="font-size:12px;color:var(--text3);">Min.</span>
            </div>
          </div>
        </div>
        <div class="field full">
          <label>Google Maps API-Key
            <span style="font-weight:400;color:var(--text3);font-size:11px;">
              (für präzise Fahrzeitberechnung – ohne Key: kostenlose Luftlinien-Schätzung)
            </span>
          </label>
          <input type="password" id="s_gmapsKey" value="${s.gmapsKey||''}"
            placeholder="AIza... (optional)" />
          <p style="font-size:12px;color:var(--text3);margin-top:5px;">
            <i class="ti ti-info-circle"></i>
            Key erstellen unter <a href="https://console.cloud.google.com" target="_blank"
            style="color:var(--accent);">console.cloud.google.com</a>
            → Distance Matrix API aktivieren. Bei ÖPNV/Zug wird zusätzlich die Deutsche Bahn API abgefragt.
          </p>
        </div>
      </div>
    </div>

    <!-- ── VERFÜGBARKEIT PRO TAG ── -->
    <div class="settings-section">
      <h3>Verfügbarkeit pro Wochentag</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">Aktiviere die Tage und lege deine Arbeitszeiten fest – inkl. optionaler Pause.</p>

      <style>
        .day-avail-row { transition: opacity .2s; }
        .day-avail-row.disabled { opacity: .45; }
        .day-avail-row.disabled .time-sel-wrap { pointer-events: none; }
        .time-sel-wrap { display:flex;align-items:center;gap:4px; }
        .time-sel {
          appearance:none;-webkit-appearance:none;
          background:var(--bg2);border:1px solid var(--border2);
          color:var(--text);border-radius:7px;padding:5px 8px;
          font-size:13px;font-family:inherit;cursor:pointer;outline:none;
          text-align:center;min-width:52px;
        }
        .time-sel:focus { border-color:var(--accent); }
        .time-sep { font-size:14px;font-weight:600;color:var(--text3); }
        .time-block-label {
          font-size:11px;font-weight:600;color:var(--text3);
          text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px;
        }
        .day-toggle-label {
          display:flex;align-items:center;gap:0;cursor:pointer;
          background:var(--bg3);border:1px solid var(--border);
          border-radius:20px;padding:4px 6px 4px 4px;width:fit-content;
          transition:all .15s;user-select:none;
        }
        .day-toggle-label input { display:none; }
        .day-toggle-dot {
          width:22px;height:22px;border-radius:50%;background:var(--border2);
          display:flex;align-items:center;justify-content:center;
          font-size:11px;font-weight:700;transition:all .2s;margin-right:6px;flex-shrink:0;
        }
        .day-toggle-label.active .day-toggle-dot { background:var(--accent);color:#fff; }
        .day-toggle-label.active { border-color:rgba(59,130,246,0.4);background:rgba(59,130,246,0.06); }
      </style>

      <div style="display:flex;flex-direction:column;gap:8px;" id="dayConfigContainer">
        ${dayLabels.map(dl => {
          const dc = dayConfigs[dl.v] || defaultDayConfig;
          const enabled = dc.enabled;

          // Build hour options
          const hours = Array.from({length:16}, (_,i) => i+6); // 06–21
          const mins  = ['00','15','30','45'];

          function timeSel(cls, val, day) {
            const [hStr, mStr] = (val || '09:00').split(':');
            const hVal = parseInt(hStr, 10);
            const mVal = mStr || '00';
            return `
              <div class="time-sel-wrap">
                <select class="${cls}-h time-sel" data-day="${day}">
                  ${hours.map(h => `<option value="${h}" ${h===hVal?'selected':''}>${String(h).padStart(2,'0')}</option>`).join('')}
                </select>
                <span class="time-sep">:</span>
                <select class="${cls}-m time-sel" data-day="${day}">
                  ${mins.map(m => `<option value="${m}" ${m===mVal?'selected':''}>${m}</option>`).join('')}
                </select>
              </div>`;
          }

          const startSel    = timeSel('day-start',       dc.start      || '09:00', dl.v);
          const endSel      = timeSel('day-end',         dc.end        || '18:00', dl.v);
          const brkStartSel = timeSel('day-break-start', dc.breakStart || '12:00', dl.v);
          const brkEndSel   = timeSel('day-break-end',   dc.breakEnd   || '13:00', dl.v);

          // Has break configured?
          const hasBrk = !!(dc.breakStart && dc.breakEnd);

          return `
          <div class="day-avail-row${enabled?'':' disabled'}" data-day-row="${dl.v}"
            style="background:var(--bg3);border:1px solid ${enabled?'rgba(59,130,246,0.2)':'var(--border)'};
            border-radius:12px;padding:14px 16px;">

            <!-- Row header: toggle + day name + break toggle -->
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${enabled?'12':'0'}px;">
              <label class="day-toggle-label${enabled?' active':''}" id="dtl_${dl.v}">
                <input type="checkbox" class="avail-day-toggle" data-day="${dl.v}" ${enabled?'checked':''}
                  onchange="window._dayToggle(${dl.v},this.checked)" />
                <span class="day-toggle-dot">${dl.l.slice(0,2)}</span>
                <span style="font-size:14px;font-weight:600;">${dl.l}</span>
              </label>
              ${enabled ? `
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text3);">
                <input type="checkbox" id="brk_toggle_${dl.v}" ${hasBrk?'checked':''}
                  onchange="window._brkToggle(${dl.v},this.checked)"
                  style="width:14px;height:14px;accent-color:var(--accent);" />
                Pause
              </label>` : ''}
            </div>

            <!-- Time pickers (only if enabled) -->
            ${enabled ? `
            <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;">
              <!-- Arbeitszeit -->
              <div>
                <div class="time-block-label">Von</div>
                ${startSel}
              </div>
              <div style="padding-top:20px;color:var(--text3);font-size:18px;">→</div>
              <div>
                <div class="time-block-label">Bis</div>
                ${endSel}
              </div>

              <!-- Pause (collapsible) -->
              <div id="brk_block_${dl.v}" style="display:${hasBrk?'flex':'none'};gap:8px;align-items:flex-start;
                padding:8px 12px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);
                border-radius:8px;flex-wrap:wrap;">
                <div>
                  <div class="time-block-label" style="color:var(--amber);">☕ Pause von</div>
                  ${brkStartSel}
                </div>
                <div style="padding-top:20px;color:var(--text3);font-size:18px;">–</div>
                <div>
                  <div class="time-block-label" style="color:var(--amber);">bis</div>
                  ${brkEndSel}
                </div>
              </div>
            </div>` : ''}
          </div>`;
        }).join('')}
      </div>

      <script>
        window._dayToggle = function(day, enabled) {
          const row = document.querySelector('[data-day-row="'+day+'"]');
          const lbl = document.getElementById('dtl_'+day);
          if (!row || !lbl) return;
          row.classList.toggle('disabled', !enabled);
          lbl.classList.toggle('active', enabled);
          row.style.borderColor = enabled ? 'rgba(59,130,246,0.2)' : 'var(--border)';
          // Re-render the row content by toggling the time blocks visibility
          // Instead of re-render, just navigate to settings page again is handled by save
        };
        window._brkToggle = function(day, show) {
          const blk = document.getElementById('brk_block_'+day);
          if (blk) blk.style.display = show ? 'flex' : 'none';
        };
      </script>

      <div class="form-grid" style="margin-top:14px;">
        <div class="field full"><label>Gesperrte Einzeltage (kommagetrennt, z.B. 2025-12-24,2025-12-25)</label>
          <input type="text" id="s_blockedDates" placeholder="YYYY-MM-DD, YYYY-MM-DD..." value="${(s.blockedDates||[]).join(', ')}" />
        </div>
      </div>
    </div>

    <!-- ── TERMIN BENACHRICHTIGUNG ── -->
    <div class="settings-section">
      <h3>🔔 Termin Benachrichtigung</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">
        Sobald du einen Termin einträgst, wird automatisch eine Bestätigungs-E-Mail über dein Gmail-Konto versendet – inklusive Kalender-Datei (.ics), die der Empfänger mit einem Klick in seinen Kalender eintragen kann (Google, Apple, Outlook – alles).
      </p>

      <div style="display:flex;flex-direction:column;gap:12px;">

        <!-- Gmail Absender -->
        <div style="background:var(--bg3);border:1px solid ${s.gcalOAuthClientId ? 'rgba(16,185,129,0.4)' : 'var(--border)'};border-radius:10px;padding:14px 16px;">
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <div style="font-size:22px;margin-top:2px;">📨</div>
            <div style="flex:1;">
              <div style="font-weight:600;font-size:14px;margin-bottom:6px;">Absender-Gmail</div>
              <div style="font-size:13px;color:var(--text2);margin-bottom:10px;">
                E-Mails werden direkt über dein Gmail-Konto versendet. Nutzt dieselbe OAuth Client-ID wie der Google Kalender – kein extra Setup nötig.
              </div>
              <div class="form-grid">
                <div class="field full">
                  <label>Gmail-Adresse (Absender)</label>
                  <input type="email" id="s_gmailSender" placeholder="nawin.telis@gmail.com" value="${s.gmailSender || 'nawin.telis@gmail.com'}" />
                </div>
              </div>
              <div style="margin-top:10px;font-size:13px;color:${s.gcalOAuthClientId ? 'var(--green)' : 'var(--amber)'};">
                <i class="ti ti-${s.gcalOAuthClientId ? 'check-circle' : 'alert-circle'}"></i>
                ${s.gcalOAuthClientId
                  ? 'OAuth aktiv – E-Mails werden vollautomatisch über Gmail versendet'
                  : 'OAuth Client-ID fehlt – bitte unten im Google Kalender Abschnitt eintragen. Danach läuft alles automatisch.'}
              </div>
              <div style="margin-top:8px;font-size:12px;color:var(--text3);">
                <i class="ti ti-info-circle"></i> Beim ersten Versand öffnet sich einmalig ein Google-Login-Fenster zur Freigabe. Danach läuft alles im Hintergrund.
              </div>
            </div>
          </div>
        </div>

        <!-- ICS Kalender -->
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px 16px;">
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <div style="font-size:22px;margin-top:2px;">📅</div>
            <div style="flex:1;">
              <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Kalender-Einladung (.ics) in jeder E-Mail</div>
              <div style="font-size:13px;color:var(--text2);">
                Jede Terminbestätigung enthält automatisch eine <strong>.ics-Datei</strong> als Anhang. Der Empfänger klickt einmal drauf – Termin direkt im Kalender. Funktioniert mit Google, Apple, Outlook und allen anderen Kalender-Apps.
              </div>
              <div style="margin-top:8px;font-size:12px;color:var(--green);"><i class="ti ti-check-circle"></i> Immer aktiv – kein Setup nötig</div>
            </div>
          </div>
        </div>

        <!-- Automatik -->
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px 16px;">
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <div style="font-size:22px;margin-top:2px;">⚡</div>
            <div style="flex:1;">
              <div style="font-weight:600;font-size:14px;margin-bottom:8px;">Automatik-Optionen</div>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px;">
                <input type="checkbox" id="s_autoConfirm" ${s.autoConfirm?'checked':''} />
                <span style="font-size:13px;">Bestätigung standardmäßig aktiviert (beim Einplanen eines Termins)</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="s_autoReminder" ${s.autoReminder?'checked':''} />
                <span style="font-size:13px;">Erinnerung standardmäßig aktiviert (am Tag des Termins)</span>
              </label>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- ── GOOGLE KALENDER ── -->
    <div class="settings-section">
      <h3>Google Kalender API</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">Jeder Google-Account braucht seinen eigenen API-Key. Beide findest du unter <a href="https://console.cloud.google.com" target="_blank" style="color:var(--accent);">console.cloud.google.com</a> → Calendar API → Anmeldedaten.</p>
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px;">
        <div style="font-size:13px;font-weight:600;color:var(--accent);margin-bottom:10px;">🟠 Kalender 1 – nawin.telis@gmail.com</div>
        <div class="form-grid">
          <div class="field full"><label>API-Key (Kalender 1)</label>
            <input type="password" id="s_gcalKey" placeholder="API-Key für nawin.telis@gmail.com..." value="${s.gcalKey||''}" />
          </div>
          <div class="field full"><label>Calendar-ID (Kalender 1)</label>
            <input type="text" id="s_gcalId" placeholder="nawin.telis@gmail.com" value="${s.gcalId||'nawin.telis@gmail.com'}" />
          </div>
        </div>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;">
        <div style="font-size:13px;font-weight:600;color:#10b981;margin-bottom:10px;">🟢 Kalender 2 – nawin.dep@gmail.com</div>
        <div class="form-grid">
          <div class="field full"><label>API-Key (Kalender 2)</label>
            <input type="password" id="s_gcalKey2" placeholder="API-Key für nawin.dep@gmail.com..." value="${s.gcalKey2||''}" />
          </div>
          <div class="field full"><label>Calendar-ID (Kalender 2)</label>
            <input type="text" id="s_gcalId2" placeholder="nawin.dep@gmail.com" value="${s.gcalId2||'nawin.dep@gmail.com'}" />
          </div>
        </div>
      </div>
      <!-- OAuth für das Schreiben -->
      <div style="background:var(--bg3);border:1px solid rgba(167,139,250,0.3);border-radius:10px;padding:14px;margin-top:12px;">
        <div style="font-size:13px;font-weight:600;color:var(--purple);margin-bottom:6px;">🔐 OAuth 2.0 – Termine automatisch eintragen</div>
        <p style="font-size:12px;color:var(--text2);margin-bottom:10px;">
          Damit Termine automatisch in Google Kalender eingetragen werden, OAuth Client-ID eintragen.<br>
          <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:var(--accent);">Google Cloud Console</a>
          → OAuth 2.0-Client-IDs → Stift-Icon → Autorisierte JS-Quellen: <code style="font-size:11px;background:var(--bg2);padding:1px 5px;border-radius:3px;">https://nawin-asuramuni.github.io</code>
        </p>
        <div class="field full"><label>OAuth Client-ID</label>
          <input type="text" id="s_gcalOAuthClientId" placeholder="xxxxxx.apps.googleusercontent.com" value="${s.gcalOAuthClientId||''}" style="font-size:12px;" />
        </div>
        ${s.gcalOAuthClientId ? `<div style="margin-top:8px;font-size:12px;color:var(--green);"><i class="ti ti-check-circle"></i> OAuth aktiv – Termine werden automatisch eingetragen</div>` : `<div style="margin-top:8px;font-size:12px;color:var(--text3);"><i class="ti ti-info-circle"></i> Ohne OAuth wird beim Einplanen das Google Kalender-Fenster geöffnet</div>`}
      </div>
      <p style="font-size:12px;color:var(--text3);margin-top:8px;">
        ${s.gcalKey ? `<span style="color:var(--green)"><i class="ti ti-check-circle"></i> API-Key hinterlegt – Sync in beide Kalender aktiv</span>` : `<i class="ti ti-info-circle"></i> API-Key unter console.cloud.google.com → Calendar API erstellen`}
      </p>
      <button class="btn-ghost" id="loadGcalBtn" style="margin-top:10px;font-size:13px;">
        <i class="ti ti-refresh"></i> Termine aus Google Kalender laden
      </button>
    </div>

    <!-- ── OUTLOOK ── -->
    <div class="settings-section">
      <h3>Outlook / Microsoft 365 API</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">
        Wird für den automatischen E-Mail-Versand der Terminbestätigung genutzt. Die App-Registrierung ist kostenlos und dauert ca. 3 Minuten.
      </p>
      <div class="form-grid">
        <div class="field full"><label>Microsoft App Client-ID</label>
          <input type="text" id="s_msClientId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${s.msClientId||''}" />
        </div>
        <div class="field full"><label>Outlook E-Mail (Absender)</label>
          <input type="email" id="s_msEmail" placeholder="deine@outlook.com oder deine@hotmail.com" value="${s.msEmail||''}" />
        </div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button class="btn-ghost" id="testOutlookBtn" style="font-size:13px;">
          <i class="ti ti-send"></i> Verbindung testen
        </button>
        <span id="outlookTestResult" style="font-size:13px;"></span>
      </div>
      <p style="font-size:12px;color:var(--text3);margin-top:10px;">
        ${s.msClientId
          ? `<span style="color:var(--green)"><i class="ti ti-check-circle"></i> Client-ID hinterlegt – E-Mail-Versand aktiv</span>`
          : `<i class="ti ti-info-circle"></i> Anleitung: <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" style="color:var(--accent);">portal.azure.com</a> → App registrations → New registration → Redirect URI: <code style="background:var(--bg3);padding:1px 4px;border-radius:3px;">https://nawin-asuramuni.github.io/Beratung/</code> → API permissions → Mail.Send (Delegated)`}
      </p>
    </div>

    <!-- ── MONDAY ── -->
    <div class="settings-section">
      <h3>Monday.com Integration</h3>
      <div class="form-grid">
        <div class="field full"><label>Monday API-Key</label>
          <input type="password" id="s_mondayKey" placeholder="API-Key aus Monday Einstellungen..." value="${s.mondayKey||''}" />
        </div>
        <div class="field full"><label>Board-ID</label>
          <input type="text" id="s_mondayBoard" placeholder="z.B. 1234567890" value="${s.mondayBoardId||''}" />
        </div>
      </div>
      <p style="font-size:12px;color:var(--text3);margin-top:8px;">Den API-Key findest du in Monday unter: Profilbild → Entwickler → API</p>
    </div>

    <!-- ── WEBSEITENEINSTELLUNGEN ── -->
    ${(() => {
      const ws = JSON.parse(localStorage.getItem('siteAdminSettings') || '{}');
      return `
    <div class="settings-section">
      <h3>🌐 Webseiteneinstellungen</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">
        Einstellungen für die öffentliche Unternehmensberatungsseite – direkt hier verwaltbar.
      </p>

      <div style="display:flex;flex-direction:column;gap:12px;">

        <!-- Urlaubs-Banner -->
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px 16px;">
          <div style="font-weight:600;font-size:14px;margin-bottom:10px;">🌴 Urlaubs-Banner</div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:10px;">
            <input type="checkbox" id="ws_vacationActive" ${ws.vacationActive ? 'checked' : ''} />
            <span style="font-size:13px;">Banner auf der Website anzeigen</span>
          </label>
          <input type="text" id="ws_vacationText"
            placeholder="Ich bin bis 01.08. im Urlaub. Ab 02.08. sind wieder Termine verfügbar."
            value="${ws.vacationText || ''}"
            style="width:100%;background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:8px;padding:8px 12px;font-size:13px;outline:none;font-family:inherit;" />
        </div>

        <!-- Kontaktdaten -->
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px 16px;">
          <div style="font-weight:600;font-size:14px;margin-bottom:12px;">📞 Kontaktdaten auf der Website</div>
          <div class="form-grid">
            <div class="field full"><label>Telefonnummer (Footer)</label>
              <input type="text" id="ws_phone" placeholder="+49 152 0233 3694" value="${ws.phone || ''}"
                style="background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:8px;padding:8px 12px;font-size:13px;outline:none;font-family:inherit;width:100%;" />
            </div>
            <div class="field full"><label>WhatsApp-Nummer (mit Ländervorwahl, ohne +)</label>
              <input type="text" id="ws_waNumber" placeholder="4915202333694" value="${ws.waNumber || ''}"
                style="background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:8px;padding:8px 12px;font-size:13px;outline:none;font-family:inherit;width:100%;" />
            </div>
            <div class="field full"><label>E-Mail-Adresse (Kontaktformular)</label>
              <input type="email" id="ws_email" placeholder="deine@email.de" value="${ws.email || ''}"
                style="background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:8px;padding:8px 12px;font-size:13px;outline:none;font-family:inherit;width:100%;" />
            </div>
          </div>
        </div>

        <!-- Impressum & Datenschutz -->
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px 16px;">
          <div style="font-weight:600;font-size:14px;margin-bottom:6px;">📄 Impressum & Datenschutz</div>
          <p style="font-size:12px;color:var(--text2);line-height:1.6;">
            Die Seiten <strong>impressum.html</strong> und <strong>datenschutz.html</strong> liegen direkt im GitHub-Repository
            und werden automatisch verlinkt. Einfach die Dateien dort hochladen oder bearbeiten – kein Upload hier nötig.
          </p>
        </div>

        <!-- Präsentationen -->
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px 16px;">
          <div style="font-weight:600;font-size:14px;margin-bottom:6px;">🎞️ Präsentationen</div>
          <p style="font-size:12px;color:var(--text2);line-height:1.6;">
            Präsentationen als <strong>.html-Dateien</strong> direkt ins GitHub-Repository hochladen.
            Sie erscheinen automatisch im Präsentations-Bereich der Website.
          </p>
        </div>

      </div>
    </div>`;
    })()}

    <!-- ── ÖFFENTLICHE WOCHENÜBERSICHT ── -->
    <div class="settings-section">
      <h3>Öffentliche Wochenübersicht</h3>
      <p style="font-size:12px;color:var(--text3);margin-bottom:16px;">
        Die Seite <code style="background:var(--bg2);padding:1px 5px;border-radius:3px;">wochenplan-public.html</code>
        zeigt eine anonymisierte Wochenansicht (ohne Klarnamen) für Dritte.
        Lege hier das Zugriffspasswort fest. Nach dem Speichern wird es sicher in Firestore hinterlegt.
      </p>
      <div style="display:flex;flex-direction:column;gap:12px;">

        <!-- Passwortfeld mit Toggle + Sofort-Speichern -->
        <div class="field full">
          <label>Zugriffspasswort Wochenübersicht</label>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="password" id="s_publicWeekPassword"
              placeholder="Passwort festlegen…"
              value="${s.publicWeekPassword || ''}"
              style="flex:1;margin-bottom:0;" />
            <button type="button" id="toggleWpPw" class="btn-ghost"
              style="padding:9px 13px;flex-shrink:0;border-radius:8px;"
              title="Passwort anzeigen">
              <i class="ti ti-eye"></i>
            </button>
            <button type="button" id="saveWpPw" class="btn-primary"
              style="padding:9px 18px;flex-shrink:0;white-space:nowrap;border-radius:8px;">
              <i class="ti ti-device-floppy"></i> Speichern
            </button>
          </div>
          <div id="wpPwStatus" style="font-size:11px;margin-top:6px;min-height:16px;color:var(--text3);"></div>
        </div>

        <!-- Link-Buttons -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-ghost" onclick="window.open('wochenplan-public.html','_blank')" style="white-space:nowrap;">
            <i class="ti ti-external-link"></i> Seite öffnen
          </button>
          <button class="btn-ghost" id="copyWpLinkBtn" style="white-space:nowrap;">
            <i class="ti ti-copy"></i> Link kopieren
          </button>
        </div>

      </div>
    </div>

    <div style="margin-top:8px;">
      <button class="btn-primary" id="saveSettings"><i class="ti ti-device-floppy"></i> Alle Einstellungen speichern</button>
    </div>
  `;

  // ── Wochenplan-Passwort: Toggle + Sofort-Speichern ──
  (function() {
    const inp    = document.getElementById('s_publicWeekPassword');
    const toggle = document.getElementById('toggleWpPw');
    const saveBtn= document.getElementById('saveWpPw');
    const copyBtn= document.getElementById('copyWpLinkBtn');
    const status = document.getElementById('wpPwStatus');
    if (!inp || !toggle || !saveBtn) return;

    // Link kopieren
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const link = location.origin + location.pathname.replace(/[^/]*$/, '') + 'wochenplan-public.html';
        navigator.clipboard.writeText(link).then(() => {
          status.innerHTML = '<span style="color:var(--green)"><i class="ti ti-check"></i> Link kopiert!</span>';
          setTimeout(() => status.innerHTML = '', 2500);
        });
      });
    }

    // Toggle Sichtbarkeit
    toggle.addEventListener('click', () => {
      const visible = inp.type === 'text';
      inp.type = visible ? 'password' : 'text';
      toggle.innerHTML = visible
        ? '<i class="ti ti-eye"></i>'
        : '<i class="ti ti-eye-off"></i>';
      toggle.title = visible ? 'Passwort anzeigen' : 'Passwort verbergen';
    });

    // Sofort-Speichern direkt in Firestore
    saveBtn.addEventListener('click', async () => {
      const pw = inp.value.trim();
      if (!pw) {
        status.innerHTML = '<span style="color:var(--amber);"><i class="ti ti-alert-circle"></i> Bitte ein Passwort eingeben.</span>';
        return;
      }
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 0.8s linear infinite;display:inline-block;"></i> Speichere…';
      status.innerHTML = '';
      try {
        // Erst localStorage updaten
        const s2 = JSON.parse(localStorage.getItem('crmSettings') || '{}');
        s2.publicWeekPassword = pw;
        localStorage.setItem('crmSettings', JSON.stringify(s2));
        // Dann direkt nach Firestore schreiben
        const { setDoc, doc: fsDoc, getFirestore } = await import('https://www.gstatic.com/firebasejs/11.3.1/firebase-firestore.js');
        await setDoc(fsDoc(db, 'publicSettings', 'main'), { publicWeekPassword: pw }, { merge: true });
        status.innerHTML = '<span style="color:var(--green);"><i class="ti ti-check-circle"></i> Passwort gespeichert & in Firestore hinterlegt.</span>';
        setTimeout(() => { status.innerHTML = ''; }, 4000);
      } catch(e) {
        status.innerHTML = '<span style="color:var(--red);"><i class="ti ti-x-circle"></i> Fehler: ' + e.message + '</span>';
      }
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="ti ti-device-floppy"></i> Speichern';
    });
  })();

  // ── Terminarten ──
  const defaultApptTypes = [
    { name: 'Erstgespräch', color: '#3b82f6', duration: 30 },
    { name: 'Beratungstermin', color: '#a78bfa', duration: 60 },
    { name: 'Folgegespräch', color: '#22c55e', duration: 20 },
  ];
  const defaultStaffApptTypes = [
    { name: 'Team-Meeting', color: '#8b5cf6', duration: 60 },
    { name: 'Einzelgespräch', color: '#6d28d9', duration: 30 },
  ];
  let apptTypes = JSON.parse(JSON.stringify(s.apptTypes || defaultApptTypes));
  let staffApptTypes = JSON.parse(JSON.stringify(s.staffApptTypes || defaultStaffApptTypes));

  function _renderApptTypeList(list, containerId, colorClass, nameClass, durClass, deleteFn) {
    document.getElementById(containerId).innerHTML = list.map((t, i) => `
      <div style="display:flex;align-items:center;gap:8px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;flex-wrap:wrap;">
        <input type="color" value="${t.color}" data-idx="${i}" class="${colorClass}"
          style="width:32px;height:32px;border:none;border-radius:6px;cursor:pointer;padding:2px;background:none;" />
        <input type="text" value="${t.name}" data-idx="${i}" class="${nameClass}" placeholder="Terminart..."
          style="flex:1;min-width:120px;background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 10px;font-size:14px;outline:none;" />
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:12px;color:var(--text3);">Dauer</span>
          <input type="number" value="${t.duration}" data-idx="${i}" class="${durClass}" min="5" max="480" step="5"
            style="width:64px;background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 8px;font-size:14px;outline:none;text-align:center;" />
          <span style="font-size:12px;color:var(--text3);">Min.</span>
        </div>
        <button onclick="${deleteFn}(${i})" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:18px;padding:2px 4px;" title="Löschen"><i class="ti ti-trash"></i></button>
      </div>`).join('');
  }

  function renderApptTypes() {
    _renderApptTypeList(apptTypes, 'apptTypesList', 'at-color', 'at-name', 'at-dur', 'window._deleteApptType');
  }
  function renderStaffApptTypes() {
    _renderApptTypeList(staffApptTypes, 'staffApptTypesList', 'st-color', 'st-name', 'st-dur', 'window._deleteStaffApptType');
  }
  renderApptTypes();
  renderStaffApptTypes();

  // ── Signatur-Bild Upload ──
  const sigInput = document.getElementById('s_sigImageInput');
  if (sigInput) {
    sigInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 500 * 1024) {
        toast('Bild zu groß (max. 500 KB). Bitte ein kleineres Bild wählen.', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const base64 = ev.target.result;
        const preview = document.getElementById('s_sigImagePreview');
        if (preview) {
          preview.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-top:4px;">
              <img src="${base64}" style="max-height:40px;max-width:120px;object-fit:contain;border-radius:4px;" />
              <span style="font-size:12px;color:var(--green);flex:1;"><i class="ti ti-check-circle"></i> Bild bereit zum Speichern</span>
            </div>`;
        }
        // Insert {bild} placeholder into textarea if not already there
        const ta = document.getElementById('s_emailSig');
        if (ta && !ta.value.includes('{bild}')) {
          ta.value = ta.value + (ta.value.trim() ? '\n' : '') + '{bild}';
        }
        sigInput._pendingBase64 = base64;
        toast('Bild geladen – klicke auf Speichern, um es zu hinterlegen.');
      };
      reader.readAsDataURL(file);
    });
  }

  // ── Signatur-Bild entfernen ──
  document.getElementById('s_removeSigImage')?.addEventListener('click', () => {
    if (sigInput) sigInput._pendingBase64 = '__remove__';
    const ta = document.getElementById('s_emailSig');
    if (ta) ta.value = ta.value.replace(/\n?\{bild\}/g, '');
    const block = document.getElementById('s_removeSigImage')?.closest('div[style]');
    if (block) {
      block.innerHTML = `<div id="s_sigImagePreview" style="margin-top:8px;"><span style="font-size:12px;color:var(--text3);">Bild wird beim Speichern entfernt.</span></div>`;
    }
  });

  window._deleteApptType = (i) => { apptTypes.splice(i, 1); renderApptTypes(); };
  window._deleteStaffApptType = (i) => { staffApptTypes.splice(i, 1); renderStaffApptTypes(); };

  document.getElementById('addApptType').addEventListener('click', () => {
    apptTypes.push({ name: '', color: '#3b82f6', duration: 30 });
    renderApptTypes();
    const inputs = document.querySelectorAll('.at-name');
    inputs[inputs.length - 1]?.focus();
  });

  document.getElementById('addStaffApptType').addEventListener('click', () => {
    staffApptTypes.push({ name: '', color: '#8b5cf6', duration: 30 });
    renderStaffApptTypes();
    const inputs = document.querySelectorAll('.st-name');
    inputs[inputs.length - 1]?.focus();
  });

  document.getElementById('saveSettings').addEventListener('click', () => {
    // Collect per-day configs
    const dayConfigs = {};
    dayLabels.forEach(dl => {
      const enabled = document.querySelector(`.avail-day-toggle[data-day="${dl.v}"]`)?.checked || false;
      const pad2 = n => String(n).padStart(2,'0');

      const sH = document.querySelector(`.day-start-h[data-day="${dl.v}"]`)?.value;
      const sM = document.querySelector(`.day-start-m[data-day="${dl.v}"]`)?.value;
      const eH = document.querySelector(`.day-end-h[data-day="${dl.v}"]`)?.value;
      const eM = document.querySelector(`.day-end-m[data-day="${dl.v}"]`)?.value;
      const start = (sH && sM) ? `${pad2(sH)}:${sM}` : '09:00';
      const end   = (eH && eM) ? `${pad2(eH)}:${eM}` : '18:00';

      const brkOn = document.getElementById(`brk_toggle_${dl.v}`)?.checked || false;
      const bsH = document.querySelector(`.day-break-start-h[data-day="${dl.v}"]`)?.value;
      const bsM = document.querySelector(`.day-break-start-m[data-day="${dl.v}"]`)?.value;
      const beH = document.querySelector(`.day-break-end-h[data-day="${dl.v}"]`)?.value;
      const beM = document.querySelector(`.day-break-end-m[data-day="${dl.v}"]`)?.value;
      const breakStart = (brkOn && bsH && bsM) ? `${pad2(bsH)}:${bsM}` : '';
      const breakEnd   = (brkOn && beH && beM) ? `${pad2(beH)}:${beM}` : '';

      dayConfigs[dl.v] = { enabled, start, end, breakStart, breakEnd };
    });

    // Collect apptTypes from live inputs
    document.querySelectorAll('.at-name').forEach(el => { apptTypes[el.dataset.idx].name = el.value.trim(); });
    document.querySelectorAll('.at-color').forEach(el => { apptTypes[el.dataset.idx].color = el.value; });
    document.querySelectorAll('.at-dur').forEach(el => { apptTypes[el.dataset.idx].duration = parseInt(el.value) || 30; });
    apptTypes = apptTypes.filter(t => t.name);

    // Collect staffApptTypes from live inputs
    document.querySelectorAll('.st-name').forEach(el => { staffApptTypes[el.dataset.idx].name = el.value.trim(); });
    document.querySelectorAll('.st-color').forEach(el => { staffApptTypes[el.dataset.idx].color = el.value; });
    document.querySelectorAll('.st-dur').forEach(el => { staffApptTypes[el.dataset.idx].duration = parseInt(el.value) || 30; });
    staffApptTypes = staffApptTypes.filter(t => t.name);

    const blockedRaw = document.getElementById('s_blockedDates').value;
    const blockedDates = blockedRaw.split(',').map(d => d.trim()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));

    // Derive legacy availDays / availStart / availEnd for calendar compatibility
    const availDays = Object.entries(dayConfigs).filter(([,v]) => v.enabled).map(([k]) => parseInt(k));
    const enabledConfigs = Object.values(dayConfigs).filter(v => v.enabled);
    const availStart = enabledConfigs.map(v => v.start).sort()[0] || '09:00';
    const availEnd   = enabledConfigs.map(v => v.end).sort().reverse()[0] || '18:00';

    const settings = {
      myEmail:            document.getElementById('s_myEmail').value.trim(),
      emailSig:           document.getElementById('s_emailSig').value,
      autoConfirm:        document.getElementById('s_autoConfirm').checked,
      autoReminder:       document.getElementById('s_autoReminder').checked,
      confirmSubject:     document.getElementById('s_confirmSubject').value.trim(),
      emailConfirmText:   document.getElementById('s_emailConfirmText').value,
      notifySubject:      document.getElementById('s_notifySubject')?.value.trim() || 'Ihr Termin am {datum}',
      emailNotifyText:    document.getElementById('s_emailNotifyText')?.value || '',
      reminderSubject:    document.getElementById('s_reminderSubject').value.trim(),
      emailReminderText:  document.getElementById('s_emailReminderText').value,
      dayConfigs,
      availDays,
      availStart,
      availEnd,
      blockedDates,
      gcalOAuthClientId: document.getElementById('s_gcalOAuthClientId')?.value.trim() || '',
      gcalKey:      document.getElementById('s_gcalKey').value.trim(),
      gcalId:       document.getElementById('s_gcalId').value.trim(),
      gcalKey2:     document.getElementById('s_gcalKey2')?.value.trim() || '',
      gcalId2:      document.getElementById('s_gcalId2')?.value.trim() || 'nawin.dep@gmail.com',
      gmailSender:  document.getElementById('s_gmailSender')?.value.trim() || 'nawin.telis@gmail.com',
      msClientId:   document.getElementById('s_msClientId').value.trim(),
      msEmail:      document.getElementById('s_msEmail').value.trim(),
      mondayKey:    document.getElementById('s_mondayKey').value.trim(),
      mondayBoardId: document.getElementById('s_mondayBoard').value.trim(),
      apptTypes,
      staffApptTypes,
      erstterminDuration: parseInt(document.getElementById('s_erstterminDuration')?.value) || 30,
      verkehrsmittel: document.getElementById('s_verkehrsmittel')?.value || 'auto',
      pufferMinuten:  parseInt(document.getElementById('s_pufferMinuten')?.value) || 15,
      gmapsKey:            document.getElementById('s_gmapsKey')?.value.trim() || '',
      publicWeekPassword:  document.getElementById('s_publicWeekPassword')?.value || '',
    };

    // Signatur-Bild
    const sigInp = document.getElementById('s_sigImageInput');
    if (sigInp?._pendingBase64 === '__remove__') {
      settings.emailSigImage = '';
    } else if (sigInp?._pendingBase64) {
      settings.emailSigImage = sigInp._pendingBase64;
    } else {
      settings.emailSigImage = s.emailSigImage || '';
    }

    localStorage.setItem('crmSettings', JSON.stringify(settings));

    // ── Webseiteneinstellungen separat speichern (wird von index.html gelesen) ──
    const prevSite = JSON.parse(localStorage.getItem('siteAdminSettings') || '{}');
    const siteSettings = {
      vacationActive: document.getElementById('ws_vacationActive')?.checked || false,
      vacationText:   document.getElementById('ws_vacationText')?.value.trim() || '',
      phone:          document.getElementById('ws_phone')?.value.trim() || '',
      waNumber:       document.getElementById('ws_waNumber')?.value.trim() || '',
      email:          document.getElementById('ws_email')?.value.trim() || '',
    };

    localStorage.setItem('siteAdminSettings', JSON.stringify(siteSettings));

    syncPublicSettings();
    syncEmailSettings();
    toast('Einstellungen gespeichert!');
  });

  // ────────────────────────────────────────────────────────────

  // Google Kalender Import Button
  document.getElementById('loadGcalBtn')?.addEventListener('click', async () => {
    toast('Google Kalender werden geladen...');
    await loadGoogleCalendarEvents();
    const count = googleCalendarEvents.length;
    toast(count > 0 ? `✅ ${count} Termine aus Google Kalender geladen!` : 'Keine Termine gefunden oder API-Key fehlt.', count > 0 ? 'success' : 'error');
  });

  // Gmail Verbindung testen
  document.getElementById('testOutlookBtn')?.addEventListener('click', async () => {
    const resultEl = document.getElementById('outlookTestResult');
    resultEl.innerHTML = '<i class="ti ti-loader" style="animation:spin 1s linear infinite;display:inline-block;"></i> Gmail-Verbindung wird hergestellt...';
    resultEl.style.color = 'var(--text2)';
    const tmpSettings = JSON.parse(localStorage.getItem('crmSettings') || '{}');
    tmpSettings.msClientId = document.getElementById('s_msClientId').value.trim();
    tmpSettings.msEmail = document.getElementById('s_msEmail').value.trim();
    localStorage.setItem('crmSettings', JSON.stringify(tmpSettings));
    const token = await getGmailToken();
    if (token) {
      resultEl.innerHTML = '<i class="ti ti-check-circle"></i> Gmail verbunden – E-Mails können gesendet werden!';
      resultEl.style.color = 'var(--green)';
    } else {
      resultEl.innerHTML = '<i class="ti ti-x-circle"></i> Verbindung fehlgeschlagen – OAuth Client-ID prüfen.';
      resultEl.style.color = 'var(--red)';
    }
  });
}


// ============================================================
// BUCHUNGSLINK GENERIEREN
// ============================================================

// Beim Speichern der Einstellungen: publicSettings in Firestore synchronisieren
// (wird am Ende von renderSettings > saveSettings aufgerufen)
async function syncPublicSettings() {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  try {
    const { setDoc, doc: fsDoc } = await import("https://www.gstatic.com/firebasejs/11.3.1/firebase-firestore.js");
    await setDoc(fsDoc(db, 'publicSettings', 'main'), {
      apptTypes:      s.apptTypes      || [],
      staffApptTypes: s.staffApptTypes || [],   // ← für Mitarbeiter-Buchungslink
      erstterminDuration: s.erstterminDuration || 30,  // ← für Website-Anfrage-Picker
      dayConfigs:     s.dayConfigs     || {},
      blockedDates:   s.blockedDates   || [],
      availDays:      s.availDays      || [],
      ownerName:      s.ownerName      || '',
      // Google Kalender API-Keys für die Buchungsseite (belegte Zeiten prüfen)
      gcalKey:  s.gcalKey  || '',
      gcalId:   s.gcalId   || '',
      gcalKey2: s.gcalKey2 || '',
      gcalId2:             s.gcalId2             || '',
      publicWeekPassword:  s.publicWeekPassword  || '',   // ← für wochenplan-public.html
      gmapsKey:            s.gmapsKey            || '',   // ← für Adressfeld in Booking-Pages
    });
  } catch(e) {
    console.warn('publicSettings sync fehlgeschlagen:', e.message);
  }
}

// Mail-Texte/Signatur zusätzlich in Firestore spiegeln, damit das
// GitHub-Actions-Hintergrundskript (Terminbestätigung 1 Tag vorher,
// Erinnerung am Termintag) dieselben Texte wie die App verwenden kann.
async function syncEmailSettings() {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  try {
    const { setDoc, doc: fsDoc } = await import("https://www.gstatic.com/firebasejs/11.3.1/firebase-firestore.js");
    await setDoc(fsDoc(db, 'settings', 'email'), {
      gmailSender:        s.gmailSender        || 'nawin.telis@gmail.com',
      confirmSubject:     s.confirmSubject     || 'Terminbestätigung – {datum}',
      emailConfirmText:   s.emailConfirmText   || '',
      reminderSubject:    s.reminderSubject    || 'Erinnerung: Unser Termin heute um {uhrzeit} Uhr',
      emailReminderText:  s.emailReminderText  || '',
      notifySubject:      s.notifySubject      || 'Ihr Termin am {datum}',
      emailNotifyText:    s.emailNotifyText    || '',
      emailSig:           s.emailSig           || '',
      emailSigImage:      s.emailSigImage      || '',
    });
  } catch(e) {
    console.warn('Email-Settings sync fehlgeschlagen:', e.message);
  }
}

// ============================================================
// NEUER KONTAKT – Öffentlicher Buchungslink (ohne bestehenden Kontakt)
// ============================================================
window.generatePublicBookingLink = async function() {
  syncPublicSettings();

  const linkData = {
    contactId:       null,
    contactVorname:  '',
    contactNachname: '',
    contactTelefon:  '',
    contactEmail:    '',
    newContact:      true,
    createdAt:       serverTimestamp(),
    used:            false,
  };

  try {
    const ref    = await addDoc(collection(db, 'bookingLinks'), linkData);
    const linkId = ref.id;
    const baseUrl = `https://nawin-asuramuni.github.io/Beratung/mandanten-booking.html`;
    const fullUrl = `${baseUrl}?lid=${linkId}`;

    await navigator.clipboard.writeText(fullUrl);
    toast('✅ Öffentlicher Buchungslink kopiert!', 'success');
    showPublicBookingLinkDialog(fullUrl);
  } catch(e) {
    console.error(e);
    toast('Fehler beim Erstellen des Links.', 'error');
  }
};

// ── Allgemeiner Mitarbeiter-Buchungslink ─────────────────────────────────────
window.generateStaffBookingLink = async function(prefill = {}) {
  syncPublicSettings();

  const linkData = {
    contactId:       prefill.contactId       || null,
    contactVorname:  prefill.vorname         || '',
    contactNachname: prefill.nachname        || '',
    contactTelefon:  prefill.telefon         || '',
    contactEmail:    prefill.email           || '',
    isStaffLink:     true,
    newContact:      !prefill.contactId,
    createdAt:       serverTimestamp(),
    used:            false,
  };

  try {
    const ref    = await addDoc(collection(db, 'bookingLinks'), linkData);
    const linkId = ref.id;
    const baseUrl = `https://nawin-asuramuni.github.io/Beratung/mitarbeiter-booking.html`;
    // Personalisierter Link: zusätzlich ?vorname=...&nachname=...&email=...&telefon=...
    let fullUrl = `${baseUrl}?lid=${linkId}&mitarbeiter=1`;
    if (prefill.vorname)  fullUrl += `&vorname=${encodeURIComponent(prefill.vorname)}`;
    if (prefill.nachname) fullUrl += `&nachname=${encodeURIComponent(prefill.nachname)}`;
    if (prefill.email)    fullUrl += `&email=${encodeURIComponent(prefill.email)}`;
    if (prefill.telefon)  fullUrl += `&telefon=${encodeURIComponent(prefill.telefon)}`;
    if (prefill.mitarbeiterId) fullUrl += `&mid=${encodeURIComponent(prefill.mitarbeiterId)}`;

    await navigator.clipboard.writeText(fullUrl).catch(() => {});
    toast('✅ Mitarbeiter-Link kopiert!', 'success');
    showStaffBookingLinkDialog(fullUrl, !!prefill.vorname);
  } catch(e) {
    console.error(e);
    toast('Fehler beim Erstellen des Links.', 'error');
  }
};

function showStaffBookingLinkDialog(url, isPersonalized = false) {
  document.getElementById('staffBookingLinkDialog')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'staffBookingLinkDialog';
  dlg.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:400;
    display:flex;align-items:center;justify-content:center;padding:20px;
  `;
  dlg.innerHTML = `
    <div style="background:var(--bg2);border:1px solid rgba(16,185,129,0.4);border-radius:16px;
      padding:24px;width:100%;max-width:500px;animation:modalIn .2s ease;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px;">
          <i class="ti ti-users" style="color:#10b981;"></i>
          Mitarbeiter-Buchungslink ${isPersonalized ? '<span style="font-size:11px;background:rgba(16,185,129,0.12);color:#10b981;border-radius:6px;padding:2px 7px;margin-left:4px;">Personalisiert</span>' : ''}
        </h2>
        <button onclick="document.getElementById('staffBookingLinkDialog').remove()"
          style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:20px;">
          <i class="ti ti-x"></i>
        </button>
      </div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px;">
        ${isPersonalized
          ? 'Personalisierter Link – Daten sind vorausgefüllt und gesperrt. Nur für <strong>diesen Mitarbeiter</strong> gedacht.'
          : 'Allgemeiner Link – der Mitarbeiter trägt seine Daten selbst ein. Kann an beliebige Teammitglieder verschickt werden.'}
      </p>
      <div style="background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:8px;
        padding:10px 12px;font-size:12px;color:#10b981;font-family:'DM Mono',monospace;
        word-break:break-all;margin-bottom:14px;line-height:1.5;">${url}</div>

      ${!isPersonalized ? `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;">
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:10px;">
          <i class="ti ti-wand" style="font-size:13px;color:#8b5cf6;"></i> Personalisierten Link erstellen
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <input id="sl_vorname" type="text" placeholder="Vorname" style="background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:7px 10px;font-size:13px;outline:none;font-family:inherit;" />
          <input id="sl_nachname" type="text" placeholder="Nachname" style="background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:7px 10px;font-size:13px;outline:none;font-family:inherit;" />
          <input id="sl_email" type="email" placeholder="E-Mail" style="background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:7px 10px;font-size:13px;outline:none;font-family:inherit;" />
          <input id="sl_telefon" type="tel" placeholder="Telefon" style="background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:7px 10px;font-size:13px;outline:none;font-family:inherit;" />
        </div>
        <button onclick="window.generateStaffBookingLink({
          vorname: document.getElementById('sl_vorname').value.trim(),
          nachname: document.getElementById('sl_nachname').value.trim(),
          email: document.getElementById('sl_email').value.trim(),
          telefon: document.getElementById('sl_telefon').value.trim()
        });document.getElementById('staffBookingLinkDialog').remove();"
          style="width:100%;background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.3);color:#a78bfa;
          border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit;font-weight:600;">
          <i class="ti ti-link"></i> Personalisierten Link generieren
        </button>
      </div>` : ''}

      <div style="display:flex;gap:8px;">
        <button onclick="navigator.clipboard.writeText('${url}').then(()=>window.toast('Kopiert!','success'))"
          class="btn-primary" style="flex:1;margin-top:0;background:#10b981;border-color:#10b981;">
          <i class="ti ti-copy"></i> Kopieren
        </button>
        <a href="https://wa.me/?text=${encodeURIComponent('Hier ist dein interner Buchungslink: ' + url)}"
          target="_blank" class="btn-ghost" style="flex:1;color:var(--green);border-color:rgba(34,197,94,0.35);">
          <i class="ti ti-brand-whatsapp"></i> WhatsApp
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
}


function showPublicBookingLinkDialog(url) {
  document.getElementById('publicBookingLinkDialog')?.remove();

  const dlg = document.createElement('div');
  dlg.id = 'publicBookingLinkDialog';
  dlg.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:400;
    display:flex;align-items:center;justify-content:center;padding:20px;
  `;
  dlg.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;
      padding:24px;width:100%;max-width:480px;animation:modalIn .2s ease;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px;">
          <i class="ti ti-link" style="color:var(--purple);"></i> Öffentlicher Buchungslink
        </h2>
        <button onclick="document.getElementById('publicBookingLinkDialog').remove()"
          style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:20px;">
          <i class="ti ti-x"></i>
        </button>
      </div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px;">
        Dieser Link kann an <strong>neue Kontakte</strong> verschickt werden –
        sie tragen sich selbst ein und werden automatisch als Kontakt angelegt.
      </p>
      <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;
        padding:10px 12px;font-size:12px;color:var(--accent);font-family:'DM Mono',monospace;
        word-break:break-all;margin-bottom:14px;line-height:1.5;">${url}</div>
      <div style="display:flex;gap:8px;">
        <button onclick="navigator.clipboard.writeText('${url}').then(()=>window.toast('Kopiert!','success'))"
          class="btn-primary" style="flex:1;margin-top:0;">
          <i class="ti ti-copy"></i> Kopieren
        </button>
        <a href="https://wa.me/?text=${encodeURIComponent('Hier ist der Buchungslink für deinen Termin: ' + url)}"
          target="_blank" class="btn-ghost" style="flex:1;color:var(--green);border-color:rgba(34,197,94,0.35);">
          <i class="ti ti-brand-whatsapp"></i> WhatsApp
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
}

// ============================================================
// PRIVATER BUCHUNGSLINK (private-booking.html) für neue Kontakte
// ============================================================
window.generatePrivateBookingLink = async function() {
  const baseUrl = `https://nawin-asuramuni.github.io/Beratung/private-booking.html`;
  try {
    await navigator.clipboard.writeText(baseUrl);
    toast('✅ Privater Buchungslink kopiert!', 'success');
    showPrivateBookingLinkDialog(baseUrl);
  } catch(e) {
    console.error(e);
    toast('Fehler beim Kopieren des Links.', 'error');
  }
};

function showPrivateBookingLinkDialog(url) {
  document.getElementById('privateBookingLinkDialog')?.remove();

  const dlg = document.createElement('div');
  dlg.id = 'privateBookingLinkDialog';
  dlg.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:400;
    display:flex;align-items:center;justify-content:center;padding:20px;
  `;
  dlg.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;
      padding:24px;width:100%;max-width:480px;animation:modalIn .2s ease;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px;">
          <i class="ti ti-lock" style="color:var(--amber);"></i> Privater Buchungslink
        </h2>
        <button onclick="document.getElementById('privateBookingLinkDialog').remove()"
          style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:20px;">
          <i class="ti ti-x"></i>
        </button>
      </div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px;">
        Schick diesen Link an Personen, die sich <strong>privat eintragen</strong> sollen –
        sie geben ihren Namen und ihre Aktivität an und wählen einen freien Slot.
      </p>
      <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;
        padding:10px 12px;font-size:12px;color:var(--amber);font-family:'DM Mono',monospace;
        word-break:break-all;margin-bottom:14px;line-height:1.5;">${url}</div>
      <div style="display:flex;gap:8px;">
        <button onclick="navigator.clipboard.writeText('${url}').then(()=>window.toast('Kopiert!','success'))"
          class="btn-primary" style="flex:1;margin-top:0;">
          <i class="ti ti-copy"></i> Kopieren
        </button>
        <a href="https://wa.me/?text=${encodeURIComponent('Hier ist dein privater Buchungslink: ' + url)}"
          target="_blank" class="btn-ghost" style="flex:1;color:var(--green);border-color:rgba(34,197,94,0.35);">
          <i class="ti ti-brand-whatsapp"></i> WhatsApp
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
}

// Privater Buchungslink für einen bestimmten Kontakt (mit Name vorausgefüllt per URL-Param)
window.generatePrivateBookingLinkForContact = function(contactId) {
  const c = contacts.find(x => x.id === contactId);
  if (!c) return;
  const baseUrl = `https://nawin-asuramuni.github.io/Beratung/private-booking.html`;
  const params = new URLSearchParams();
  if (c.vorname || c.nachname) params.set('name', `${c.vorname || ''} ${c.nachname || ''}`.trim());
  if (c.telefon) params.set('tel', c.telefon);
  const fullUrl = params.toString() ? `${baseUrl}?${params.toString()}` : baseUrl;

  document.getElementById('privateBookingLinkDialog')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'privateBookingLinkDialog';
  dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:400;display:flex;align-items:center;justify-content:center;padding:20px;';
  dlg.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;
      padding:24px;width:100%;max-width:480px;animation:modalIn .2s ease;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px;">
          <i class="ti ti-lock" style="color:var(--amber);"></i> Privater Buchungslink für ${c.vorname}
        </h2>
        <button onclick="document.getElementById('privateBookingLinkDialog').remove()"
          style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:20px;">
          <i class="ti ti-x"></i>
        </button>
      </div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px;">
        Dieser Link ist für <strong>${c.vorname} ${c.nachname || ''}</strong> – Name und Telefonnummer
        sind bereits vorausgefüllt. ${c.vorname} wählt nur noch Aktivität und Zeitslot.
      </p>
      <div style="background:var(--bg3);border:1px solid rgba(245,158,11,0.3);border-radius:8px;
        padding:10px 12px;font-size:12px;color:var(--amber);font-family:'DM Mono',monospace;
        word-break:break-all;margin-bottom:14px;line-height:1.5;">${fullUrl}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="navigator.clipboard.writeText('${fullUrl}').then(()=>window.toast('Kopiert!','success'))"
          class="btn-primary" style="flex:1;margin-top:0;">
          <i class="ti ti-copy"></i> Kopieren
        </button>
        ${c.telefon ? `
        <a href="https://wa.me/${c.telefon.replace(/[^0-9]/g,'')}?text=${encodeURIComponent('Hey ' + c.vorname + ' 👋 hier ist dein persönlicher Buchungslink – einfach anklicken und deinen Wunschtermin wählen:\n' + fullUrl)}"
          target="_blank" class="btn-ghost" style="flex:1;color:var(--green);border-color:rgba(34,197,94,0.35);">
          <i class="ti ti-brand-whatsapp"></i> WhatsApp
        </a>` : ''}
        ${c.email ? `
        <a href="mailto:${c.email}?subject=Dein%20privater%20Buchungslink&body=${encodeURIComponent('Hey ' + c.vorname + ',\n\nhier ist dein persönlicher Buchungslink:\n' + fullUrl + '\n\nEinfach anklicken und deinen Wunschtermin wählen!\n\nBis bald 🙌')}"
          class="btn-ghost" style="flex:1;color:var(--purple);border-color:rgba(139,92,246,0.35);">
          <i class="ti ti-mail"></i> E-Mail
        </a>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
  navigator.clipboard.writeText(fullUrl).then(() => toast(`✅ Privater Link für ${c.vorname} kopiert!`, 'success')).catch(() => {});
};

// Buchungslink in Firestore anlegen und URL kopieren
window.generateBookingLink = async function(contactId) {
  const c = contacts.find(x => x.id === contactId);
  if (!c) return;

  // Zuerst publicSettings sicherstellen
  syncPublicSettings();

  const linkData = {
    contactId,
    contactVorname:  c.vorname  || '',
    contactNachname: c.nachname || '',
    contactTelefon:  c.telefon  || '',
    contactEmail:    c.email    || '',
    createdAt: serverTimestamp(),
    used: false,
  };

  try {
    const ref = await addDoc(collection(db, 'bookingLinks'), linkData);
    const linkId = ref.id;

    const baseUrl = `https://nawin-asuramuni.github.io/Beratung/mandanten-booking.html`;
    const fullUrl = `${baseUrl}?lid=${linkId}`;

    await navigator.clipboard.writeText(fullUrl);
    toast(`✅ Link für ${c.vorname} kopiert!`, 'success');

    // Zusätzlich: Dialog mit dem Link anzeigen
    showBookingLinkDialog(c, fullUrl);
  } catch(e) {
    console.error(e);
    toast('Fehler beim Erstellen des Links.', 'error');
  }
};

function showBookingLinkDialog(contact, url) {
  // Remove existing dialog if any
  document.getElementById('bookingLinkDialog')?.remove();

  const dlg = document.createElement('div');
  dlg.id = 'bookingLinkDialog';
  dlg.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:400;
    display:flex;align-items:center;justify-content:center;padding:20px;
  `;
  dlg.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;
      padding:24px;width:100%;max-width:480px;animation:modalIn .2s ease;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px;">
          <i class="ti ti-link" style="color:var(--purple);"></i> Buchungslink
        </h2>
        <button onclick="document.getElementById('bookingLinkDialog').remove()"
          style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:20px;">
          <i class="ti ti-x"></i>
        </button>
      </div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px;">
        Schick diesen Link an <strong>${contact.vorname} ${contact.nachname}</strong> –
        sie können darüber direkt einen Termin buchen.
      </p>
      <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;
        padding:10px 12px;font-size:12px;color:var(--accent);font-family:'DM Mono',monospace;
        word-break:break-all;margin-bottom:14px;line-height:1.5;">${url}</div>
      <div style="display:flex;gap:8px;">
        <button onclick="navigator.clipboard.writeText('${url}').then(()=>window.toast('Kopiert!','success'))"
          class="btn-primary" style="flex:1;margin-top:0;">
          <i class="ti ti-copy"></i> Kopieren
        </button>
        ${contact.email ? `
        <a href="mailto:${contact.email}?subject=Dein%20Buchungslink&body=Hallo%20${encodeURIComponent(contact.vorname)}%2C%0A%0Ahier%20ist%20dein%20pers%C3%B6nlicher%20Buchungslink%3A%0A${encodeURIComponent(url)}%0A%0AMit%20freundlichen%20Gr%C3%BC%C3%9Fen"
          class="btn-ghost" style="flex:1;">
          <i class="ti ti-mail"></i> Per E-Mail
        </a>` : ''}
        ${contact.telefon ? `
        <a href="https://wa.me/${contact.telefon.replace(/[^0-9]/g,'')}?text=${encodeURIComponent('Hallo ' + contact.vorname + ', hier ist dein persönlicher Buchungslink: ' + url)}"
          target="_blank" class="btn-ghost" style="flex:1;color:var(--green);border-color:rgba(34,197,94,0.35);">
          <i class="ti ti-brand-whatsapp"></i> WhatsApp
        </a>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
}

// ============================================================
// PRIVATE TERMIN INBOX – Aktionen
// ============================================================

// Bestätigt einen privaten Terminwunsch: setzt type/status auf 'fix', öffnet WhatsApp
window.confirmPrivateSlot = async function(slotId) {
  const slot = privateSlots.find(s => s.id === slotId);
  if (!slot) return;

  const dt = new Date(slot.datetime);
  const dtEnd = new Date(dt.getTime() + (slot.apptDuration || 60) * 60000);
  const datum = dt.toLocaleDateString('de-DE', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  const von   = dt.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
  const bis   = dtEnd.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
  const settings = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const ownerName = settings.ownerName || 'Ihr Berater';

  // Auswahl-Modal für Benachrichtigungen
  const notifDlg = document.createElement('div');
  notifDlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:700;display:flex;align-items:center;justify-content:center;padding:20px;';
  notifDlg.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:18px;
      padding:26px 22px;width:100%;max-width:420px;animation:modalIn .2s ease;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <i class="ti ti-check-circle" style="font-size:22px;color:#10b981;"></i>
        <h2 style="font-size:16px;font-weight:700;">Termin bestätigen</h2>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:13px;line-height:1.7;color:var(--text2);">
        <strong style="color:var(--text);">${slot.vorname} ${slot.nachname || ''}</strong><br>
        📅 ${datum}<br>
        🕐 ${von} – ${bis} Uhr
        ${slot.apptType ? `<br>🎯 ${slot.apptType}` : ''}
      </div>
      <div style="font-size:12px;font-weight:600;color:var(--amber);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;">
        Welche Benachrichtigungen sollen gesendet werden?
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;">
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;cursor:pointer;transition:background .15s;"
          onmouseover="this.style.background='rgba(139,92,246,0.08)'" onmouseout="this.style.background='var(--bg3)'">
          <input type="checkbox" id="pn_notify" checked style="width:16px;height:16px;accent-color:var(--purple);margin-top:1px;flex-shrink:0;" />
          <div>
            <div style="font-size:14px;font-weight:500;">📲 Terminbenachrichtigung <span style="font-size:10px;font-weight:600;color:var(--purple);background:rgba(139,92,246,0.15);padding:2px 7px;border-radius:8px;margin-left:4px;">SOFORT</span></div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;">Geht direkt beim Bestätigen raus – Termindetails mit Kalender-Datei (.ics)</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;cursor:pointer;transition:background .15s;"
          onmouseover="this.style.background='rgba(16,185,129,0.08)'" onmouseout="this.style.background='var(--bg3)'">
          <input type="checkbox" id="pn_confirm" checked style="width:16px;height:16px;accent-color:#10b981;margin-top:1px;flex-shrink:0;" />
          <div>
            <div style="font-size:14px;font-weight:500;">📧 Terminbestätigung <span style="font-size:10px;font-weight:600;color:#10b981;background:rgba(16,185,129,0.12);padding:2px 7px;border-radius:8px;margin-left:4px;">1 TAG VORHER</span></div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;">Automatisch 1 Tag vor dem Termin per E-Mail (via GitHub Actions)</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;cursor:pointer;transition:background .15s;"
          onmouseover="this.style.background='rgba(245,158,11,0.08)'" onmouseout="this.style.background='var(--bg3)'">
          <input type="checkbox" id="pn_reminder" checked style="width:16px;height:16px;accent-color:var(--amber);margin-top:1px;flex-shrink:0;" />
          <div>
            <div style="font-size:14px;font-weight:500;">🔔 Terminerinnerung <span style="font-size:10px;font-weight:600;color:var(--amber);background:rgba(245,158,11,0.12);padding:2px 7px;border-radius:8px;margin-left:4px;">TERMINTAG 9 UHR</span></div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;">Am Termintag morgens um 09:00 Uhr automatisch per E-Mail</div>
          </div>
        </label>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="pn_cancel" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--border2);
          background:none;color:var(--text2);cursor:pointer;font-size:14px;font-family:inherit;">
          Abbrechen
        </button>
        <button id="pn_confirm_btn" style="flex:2;padding:11px;border-radius:10px;border:none;
          background:#10b981;color:#fff;cursor:pointer;font-size:14px;font-weight:700;font-family:inherit;
          display:flex;align-items:center;justify-content:center;gap:7px;">
          <i class="ti ti-check"></i> Bestätigen & Senden
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(notifDlg);

  document.getElementById('pn_cancel').onclick = () => notifDlg.remove();

  document.getElementById('pn_confirm_btn').onclick = async () => {
    const sendConfirm = document.getElementById('pn_confirm').checked;
    const sendReminder = document.getElementById('pn_reminder').checked;
    const sendNotify = document.getElementById('pn_notify').checked;
    notifDlg.remove();

    // Kontakt anlegen falls noch nicht vorhanden
    let confirmedContactId = slot.contactId || null;
    try {
      if (!confirmedContactId && slot.telefon) {
        const snap = await getDocs(query(collection(db, 'contacts'), where('telefon', '==', slot.telefon)));
        if (!snap.empty) confirmedContactId = snap.docs[0].id;
      }
      if (!confirmedContactId) {
        const ref = await addDoc(collection(db, 'contacts'), {
          vorname: slot.vorname || slot.bookedBy || '',
          nachname: slot.nachname || '',
          telefon: slot.telefon || '',
          email: slot.email || '',
          ort: '', thema: slot.apptType || slot.thema || '',
          quelle: 'Privates Buchungsformular',
          status: 'Neu', type: 'private', notizen: '',
          privateContact: true, createdAt: serverTimestamp(),
          history: [{ type: 'termin', datetime: slot.datetime,
            note: `[Bestätigter Termin] ${slot.apptType || ''}`, followup: null }],
        });
        confirmedContactId = ref.id;
      }
    } catch(ce) { console.warn('Kontakt konnte nicht angelegt werden:', ce.message); }

    try {
      await updateDoc(doc(db, 'callSlots', slotId), {
        type:         'fix',
        status:       'confirmed',
        confirmedAt:  serverTimestamp(),
        contactId:    confirmedContactId || null,
        notifications: { confirm: sendConfirm, reminder: sendReminder, notify: sendNotify },
      });
      toast(`✅ Termin für ${slot.vorname} bestätigt!`, 'success');
    } catch(e) {
      console.warn('Firestore update fehlgeschlagen (Bestätigung):', e);
      const idx = privateSlots.findIndex(s => s.id === slotId);
      if (idx !== -1) { privateSlots[idx].type = 'fix'; privateSlots[idx].status = 'confirmed'; }
      toast(`Termin bestätigt (offline).`, 'success');
      renderDashboard();
    }

    // Google Kalender Sync
    try {
      await syncToGoogleCalendar(
        { ...slot, apptType: slot.apptType || slot.thema || 'Privater Termin', apptDuration: slot.apptDuration || 60, apptColor: '#c9a84c', note: `Privater Termin: ${slot.vorname}${slot.notizen ? ' – ' + slot.notizen : ''}` },
        { vorname: slot.vorname || '', nachname: slot.nachname || '', telefon: slot.telefon || '' }
      );
    } catch(e) { console.warn('GCal sync fehlgeschlagen:', e.message); }

    // Benachrichtigungen senden – per E-Mail (aus Einstellungen-Templates)
    if (slot.telefon || slot.email) {
      // Kontakt-Objekt für sendConfirmationEmail zusammenbauen
      const contactObj = {
        vorname:  slot.vorname  || slot.bookedBy || '',
        nachname: slot.nachname || '',
        email:    slot.email    || '',
        telefon:  slot.telefon  || '',
      };
      const slotObj = { datetime: slot.datetime, apptType: slot.apptType || slot.thema || 'Privater Termin', apptDuration: slot.apptDuration || 60 };

      if (contactObj.email) {
        // Alle Flags direkt per slotId setzen – kein Re-Query nötig
        try {
          const flagUpdate = {};
          if (sendConfirm)  flagUpdate.sendConfirmEmail = true;
          if (sendReminder) flagUpdate.sendReminder     = true;
          if (Object.keys(flagUpdate).length > 0) {
            await updateDoc(doc(db, 'callSlots', slotId), flagUpdate);
          }
        } catch(fe) { console.warn('Flag-Update fehlgeschlagen:', fe.message); }

        if (sendConfirm)  toast('📬 Bestätigung wird 1 Tag vor dem Termin automatisch per E-Mail versendet.', 'success');
        if (sendReminder) toast('🔔 Erinnerung am Termintag wird automatisch per E-Mail versendet.', 'success');

        if (sendNotify) {
          // Sofortige Benachrichtigungs-E-Mail mit Kalender-Einladung (.ics)
          await sendConfirmationEmail(contactObj, { ...slotObj, mailType: 'notify', withIcs: true });
        }
      } else if (sendConfirm && slot.telefon) {
        // Fallback WhatsApp wenn keine E-Mail vorhanden
        const phone = slot.telefon.replace(/[^0-9+]/g, '').replace(/^0/, '49');
        const msg = `Hey ${slot.vorname} 👋\n\nJa, passt! Ich hab uns eingetragen:\n📅 ${datum}\n🕐 ${von} – ${bis} Uhr\n${slot.apptType ? '🎯 ' + slot.apptType + '\n' : ''}\nBis dann! 🤜`;
        window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
      }
    }
  };
};


// ============================================================
// ALTERNATIVTERMIN-PICKER – gemeinsamer Kalender-Picker
// ============================================================
function openAltPickerModal({ slot, isPrivate, takenSlots, isStaff = false }) {
  document.getElementById('altPickerModal')?.remove();

  const cfg = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const dayConfigs  = cfg.dayConfigs  || {};
  const blockedDates = cfg.blockedDates || [];
  const dur = slot.apptDuration || (isPrivate ? 60 : 60);

  const months   = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const dayNames = ['Mo','Di','Mi','Do','Fr','Sa','So'];
  const pad = n => String(n).padStart(2,'0');
  const today = new Date(); today.setHours(0,0,0,0);

  let calYear  = today.getFullYear();
  let calMonth = today.getMonth();
  let pickedDate = null;
  let pickedTime = null;
  const chosen = []; // max 2

  // Belegte Zeiträume
  const taken = takenSlots.map(s => ({
    start: new Date(s.datetime),
    end:   new Date(new Date(s.datetime).getTime() + (s.apptDuration || 60) * 60000),
  }));

  function getDayConfig(jsDay) {
    return (dayConfigs[String(jsDay)] || dayConfigs[jsDay]) || null;
  }

  function isDateAvail(date) {
    // Private Termine: alle Tage außer Vergangenheit sind wählbar
    if (isPrivate) return date >= today;
    // Geschäftstermine: nur konfigurierte Arbeitstage
    const dc = getDayConfig(date.getDay());
    if (!dc || !dc.enabled) return false;
    const ds = date.getFullYear() + '-' + pad(date.getMonth()+1) + '-' + pad(date.getDate());
    if (blockedDates.includes(ds)) return false;
    return true;
  }

  function getTimeSlotsForDate(date) {
    let dayStart, dayEnd, brkS = Infinity, brkE = -Infinity;

    if (isPrivate) {
      // Private Termine: 08:00–23:00, kein Pflicht-Break
      dayStart = 8 * 60;   // 08:00
      dayEnd   = 23 * 60;  // 23:00 – letzter möglicher Start
    } else {
      const dc = getDayConfig(date.getDay());
      if (!dc) return [];
      const [sh, sm] = dc.start.split(':').map(Number);
      const [eh, em] = dc.end.split(':').map(Number);
      dayStart = sh*60+sm; dayEnd = eh*60+em;
      if (dc.breakStart && dc.breakEnd) {
        const [bsh,bsm] = dc.breakStart.split(':').map(Number);
        const [beh,bem] = dc.breakEnd.split(':').map(Number);
        brkS = bsh*60+bsm; brkE = beh*60+bem;
      }
    }

    const now = new Date();
    const slots = [];
    for (let t = dayStart; t + dur <= dayEnd + (isPrivate ? dur : 0); t += (isPrivate ? 60 : 30)) {
      if (isPrivate && t > dayEnd) break;
      if (!isPrivate && brkS !== Infinity && t < brkE && (t + dur) > brkS) continue;
      const slotDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(t/60), t%60);
      if (slotDate <= now) continue;
      const slotEnd = new Date(slotDate.getTime() + dur * 60000);
      const overlap = taken.some(tk => slotDate < tk.end && slotEnd > tk.start);
      slots.push({ time: pad(Math.floor(t/60)) + ':' + pad(t%60), free: !overlap, date: slotDate });
    }
    return slots;
  }

  function fmtChosen(d) {
    const datum = d.toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
    const von   = d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    const bis   = new Date(d.getTime() + dur * 60000).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    return `${datum}, ${von}–${bis} Uhr`;
  }

  const accentColor = isPrivate ? 'var(--amber)' : 'var(--purple)';
  const accentHex   = isPrivate ? '#f59e0b' : '#8b5cf6';

  const dlg = document.createElement('div');
  dlg.id = 'altPickerModal';
  dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:700;display:flex;align-items:center;justify-content:center;padding:16px;';

  function buildHTML() {
    const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
    const firstDow    = new Date(calYear, calMonth, 1).getDay();
    const blanks      = firstDow === 0 ? 6 : firstDow - 1;

    let calCells = dayNames.map(d => `<div style="text-align:center;font-size:11px;color:var(--text3);font-weight:600;padding:4px 0;">${d}</div>`).join('');
    for (let b = 0; b < blanks; b++) calCells += `<div></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const date  = new Date(calYear, calMonth, d);
      const isPast = date < today;
      const avail  = !isPast && isDateAvail(date);
      const isSel  = pickedDate && pickedDate.getFullYear()===calYear && pickedDate.getMonth()===calMonth && pickedDate.getDate()===d;
      let style = 'aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:13px;font-weight:500;cursor:default;';
      if (isPast || !avail)  style += `color:var(--text3);opacity:.3;`;
      else if (isSel)        style += `background:${accentHex};color:#fff;font-weight:700;cursor:pointer;`;
      else                   style += `background:rgba(255,255,255,0.06);color:var(--text);cursor:pointer;`;
      const onclick = avail ? `onclick="window._altPickDay(${calYear},${calMonth},${d})"` : '';
      calCells += `<div style="${style}" ${onclick}>${d}</div>`;
    }

    let timeHTML = '';
    if (pickedDate) {
      const slots = getTimeSlotsForDate(pickedDate);
      if (slots.length === 0) {
        timeHTML = `<p style="color:var(--text3);font-size:13px;margin-top:12px;">Keine freien Zeiten an diesem Tag.</p>`;
      } else {
        timeHTML = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:12px;">` +
          slots.map(sl => {
            const isSel = pickedTime === sl.time;
            let s = 'padding:8px 4px;text-align:center;border-radius:8px;font-size:13px;font-weight:500;';
            if (!sl.free)   s += 'background:rgba(255,255,255,0.03);color:var(--text3);opacity:.5;cursor:default;';
            else if (isSel) s += `background:${accentHex};color:#fff;cursor:pointer;`;
            else            s += `background:rgba(255,255,255,0.06);color:var(--text);cursor:pointer;border:1px solid rgba(255,255,255,0.1);`;
            const onclick = sl.free ? `onclick="window._altPickTime('${sl.time}')"` : '';
            return `<div style="${s}" ${onclick}>${sl.time}</div>`;
          }).join('') + `</div>`;
      }
    }

    let addBtnStyle = `width:100%;margin-top:10px;padding:9px;border-radius:8px;border:none;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;`;
    const canAdd = pickedDate && pickedTime && chosen.length < 2;
    addBtnStyle += canAdd ? `background:${accentHex};color:#fff;` : `background:rgba(255,255,255,0.06);color:var(--text3);cursor:default;opacity:.5;`;

    const chosenHTML = chosen.length > 0
      ? chosen.map((c,i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;
          background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;font-size:13px;">
          <span>📅 ${fmtChosen(c)}</span>
          <button onclick="window._altRemoveChosen(${i})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;padding:0 4px;">×</button>
        </div>`).join('')
      : `<p style="color:var(--text3);font-size:13px;text-align:center;padding:8px 0;">Noch kein Slot ausgewählt</p>`;

    const sendDisabled = chosen.length === 0;
    const sendStyle = `flex:2;padding:10px;border-radius:10px;border:none;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;` + (sendDisabled ? `background:rgba(255,255,255,0.08);color:var(--text3);cursor:default;opacity:.5;` : `background:${accentHex};color:#fff;`);

    return `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:18px;
      padding:22px 20px;width:100%;max-width:480px;max-height:92vh;overflow-y:auto;animation:modalIn .2s ease;">

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px;">
          <i class="ti ti-calendar-search" style="color:${accentColor};"></i>
          Alternativtermine für ${slot.vorname}${slot.nachname ? ' '+slot.nachname : ''}
        </h2>
        <button onclick="document.getElementById('altPickerModal').remove()"
          style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:20px;"><i class="ti ti-x"></i></button>
      </div>

      <!-- Kalender -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <button onclick="window._altCalPrev()" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:15px;">‹</button>
        <span style="font-weight:600;font-size:14px;">${months[calMonth]} ${calYear}</span>
        <button onclick="window._altCalNext()" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:15px;">›</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:4px;">
        ${calCells}
      </div>

      <!-- Zeiten -->
      ${timeHTML}

      <!-- Slot hinzufügen -->
      <button onclick="window._altAddSlot()" style="${addBtnStyle}">
        <i class="ti ti-plus"></i> Slot hinzufügen (${chosen.length}/2)
      </button>

      <!-- Ausgewählte Slots -->
      <div style="margin-top:14px;margin-bottom:14px;">
        <div style="font-size:11px;font-weight:600;color:${accentColor};text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Ausgewählte Alternativen</div>
        <div style="display:flex;flex-direction:column;gap:6px;">${chosenHTML}</div>
      </div>

      <!-- Nachrichtenvorschau (bearbeitbar) -->
      ${chosen.length > 0 ? `
      <div style="margin-bottom:14px;">
        <label style="font-size:12px;color:var(--text3);font-weight:600;display:block;margin-bottom:6px;">
          <i class="ti ti-pencil" style="font-size:11px;"></i> Nachricht (bearbeitbar vor dem Senden)
        </label>
        <textarea id="altPickerMsgPreview" rows="7"
          style="width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);
          border-radius:8px;padding:10px 12px;font-size:13px;font-family:inherit;resize:vertical;line-height:1.6;box-sizing:border-box;">
        </textarea>
      </div>` : ''}

      <!-- Senden -->
      <div style="display:flex;gap:8px;">
        <button onclick="document.getElementById('altPickerModal').remove()" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border2);background:none;color:var(--text2);cursor:pointer;font-size:14px;font-family:inherit;">Abbrechen</button>
        ${slot.email ? `<button id="altSendEmail" style="flex:1;padding:10px;border-radius:10px;border:none;background:rgba(99,102,241,0.15);color:var(--purple);font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;${sendDisabled?'opacity:.4;cursor:default;':''}"><i class="ti ti-mail"></i> E-Mail</button>` : ''}
        ${slot.telefon ? `<button id="altSendWa" style="${sendStyle}"><i class="ti ti-brand-whatsapp"></i> WhatsApp</button>` : ''}
      </div>
    </div>`;
  }

  function rerender() {
    dlg.innerHTML = buildHTML();
    bindSendButtons();
    const ta = document.getElementById('altPickerMsgPreview');
    if (ta) ta.value = buildAltMsg(chosen.map(c => fmtChosen(c)));
  }

  function bindSendButtons() {
    const waBtn = document.getElementById('altSendWa');
    const emailBtn = document.getElementById('altSendEmail');
    if (waBtn && chosen.length > 0) {
      waBtn.onclick = () => sendAlt('wa');
    }
    if (emailBtn && chosen.length > 0) {
      emailBtn.onclick = () => sendAlt('email');
    }
  }

  function buildAltMsg(termineLabels) {
    const cfg = JSON.parse(localStorage.getItem('crmSettings') || '{}');
    const ownerName = cfg.ownerName || '';
    let tpl;
    if (isStaff) {
      tpl = cfg.altTemplateMitarbeiter ||
        `Hallo {vorname} 👋\n\nder angeforderte Termin ({apptType}) klappt leider nicht. Ich habe für uns folgende freie Zeitfenster:\n\n{termine}\n\nSag mir kurz, was dir passt! 🙌\n{gruss}`;
    } else if (isPrivate) {
      tpl = cfg.altTemplatePrivat ||
        `Hey {vorname} 👋\n\nder gewünschte Termin klappt leider nicht – aber ich habe noch folgende freie Zeitfenster:\n\n{termine}\n\nSag mir einfach, was dir passt! 🙌\n{gruss}`;
    } else {
      tpl = cfg.altTemplateMandant ||
        `Guten Tag {vorname},\n\nder gewünschte Termin ist leider nicht verfügbar. Ich biete Ihnen folgende freie Zeitfenster an:\n\n{termine}\n\nBitte teilen Sie mir mit, welcher Termin für Sie passt.\n\nMit freundlichen Grüßen\n{gruss}`;
    }
    return tpl
      .replace(/{vorname}/g,   slot.vorname   || '')
      .replace(/{nachname}/g,  slot.nachname  || '')
      .replace(/{apptType}/g,  slot.apptType  || 'Termin')
      .replace(/{termine}/g,   termineLabels.map(l => '📅 ' + l).join('\n'))
      .replace(/{gruss}/g,     ownerName);
  }

  function sendAlt(via) {
    if (chosen.length === 0) return;
    const ta = document.getElementById('altPickerMsgPreview');
    const msg = ta ? ta.value : buildAltMsg(chosen.map(c => fmtChosen(c)));
    dlg.remove();
    if (via === 'wa') {
      const phone = (slot.telefon || '').replace(/[^0-9+]/g, '').replace(/^0/, '49');
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
    } else {
      const subject = encodeURIComponent(isPrivate ? `Alternativtermine` : `Alternativtermine für Ihr Anliegen`);
      window.open(`mailto:${slot.email}?subject=${subject}&body=${encodeURIComponent(msg)}`, '_blank');
    }
  }

  // Global callbacks für onclick-Handler im HTML
  window._altCalPrev = () => {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
    pickedDate = null; pickedTime = null; rerender();
  };
  window._altCalNext = () => {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
    pickedDate = null; pickedTime = null; rerender();
  };
  window._altPickDay = (y, m, d) => {
    pickedDate = new Date(y, m, d); pickedTime = null; rerender();
  };
  window._altPickTime = (t) => {
    pickedTime = t; rerender();
  };
  window._altAddSlot = () => {
    if (!pickedDate || !pickedTime || chosen.length >= 2) return;
    const [h, mi] = pickedTime.split(':').map(Number);
    const dt = new Date(pickedDate.getFullYear(), pickedDate.getMonth(), pickedDate.getDate(), h, mi);
    if (chosen.some(c => c.getTime() === dt.getTime())) return;
    chosen.push(dt);
    pickedTime = null;
    rerender();
  };
  window._altRemoveChosen = (i) => {
    chosen.splice(i, 1); rerender();
  };

  dlg.innerHTML = buildHTML();
  bindSendButtons();
  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
}

// Zeigt Kalender-Picker Modal für private Alternativtermine
window.offerPrivateAlternatives = function(slotId) {
  const slot = privateSlots.find(s => s.id === slotId);
  if (!slot) return;
  const takenSlots = [...callSlots, ...privateSlots.filter(s => s.id !== slotId)];
  openAltPickerModal({ slot, isPrivate: true, takenSlots });
};

function showPrivateAlternativesModal(slot, freeSlots) {
  document.getElementById('privateAltModal')?.remove();

  const pad = n => String(n).padStart(2,'0');
  const fmtSlot = d => {
    const datum = d.toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'short' });
    const von   = d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    const bis   = new Date(d.getTime() + (slot.apptDuration || 60) * 60000)
                    .toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    return `${datum}, ${von}–${bis} Uhr`;
  };

  const slotItems = freeSlots.length === 0
    ? `<p style="color:var(--text3);font-size:13px;text-align:center;padding:12px 0;">Keine freien Zeitfenster in den nächsten 14 Tagen gefunden.</p>`
    : freeSlots.map((s, i) => `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;
        background:var(--bg3);border:1px solid var(--border2);border-radius:8px;cursor:pointer;
        transition:background .15s;" onmouseover="this.style.background='rgba(245,158,11,0.08)'" onmouseout="this.style.background='var(--bg3)'">
        <input type="checkbox" class="alt-slot-check" value="${s.toISOString()}" data-label="${fmtSlot(s)}"
          style="width:16px;height:16px;accent-color:var(--amber);" />
        <span style="font-size:14px;">${fmtSlot(s)}</span>
      </label>`).join('');

  const dlg = document.createElement('div');
  dlg.id = 'privateAltModal';
  dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:600;display:flex;align-items:center;justify-content:center;padding:20px;';
  dlg.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:18px;
      padding:26px 22px;width:100%;max-width:440px;animation:modalIn .2s ease;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <h2 style="font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px;">
          <i class="ti ti-calendar-search" style="color:var(--amber);"></i>
          Alternativen für ${slot.vorname}
        </h2>
        <button onclick="document.getElementById('privateAltModal').remove()"
          style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:20px;">
          <i class="ti ti-x"></i>
        </button>
      </div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;line-height:1.5;">
        Wähle bis zu <strong>2 freie Zeitfenster</strong> aus, die du ${slot.vorname} per WhatsApp anbieten möchtest.
      </p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;" id="altSlotList">
        ${slotItems}
      </div>
      <div id="altSelectionInfo" style="font-size:12px;color:var(--text3);margin-bottom:12px;min-height:16px;"></div>
      <div style="display:flex;gap:8px;">
        <button id="altCancelBtn" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border2);
          background:none;color:var(--text2);cursor:pointer;font-size:14px;font-family:inherit;">
          Abbrechen
        </button>
        <button id="altSendBtn" style="flex:2;padding:10px;border-radius:10px;border:none;
          background:var(--amber);color:#000;cursor:pointer;font-size:14px;font-weight:700;font-family:inherit;
          display:flex;align-items:center;justify-content:center;gap:7px;">
          <i class="ti ti-brand-whatsapp"></i> Per WhatsApp anbieten
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });

  document.getElementById('altCancelBtn').onclick = () => dlg.remove();

  // Max 2 auswählen
  const info = document.getElementById('altSelectionInfo');
  dlg.querySelectorAll('.alt-slot-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = [...dlg.querySelectorAll('.alt-slot-check:checked')];
      if (checked.length > 2) { cb.checked = false; return; }
      info.textContent = checked.length === 0 ? '' : `${checked.length} von 2 ausgewählt`;
    });
  });

  document.getElementById('altSendBtn').onclick = () => {
    const checked = [...dlg.querySelectorAll('.alt-slot-check:checked')];
    if (checked.length === 0) { toast('Bitte mindestens einen Slot auswählen.', 'error'); return; }

    const labels = checked.map(c => '📅 ' + c.dataset.label);
    const msg = `Hey ${slot.vorname} 👋\n\nDer gewünschte Termin klappt leider nicht – aber ich habe noch folgende freie Zeitfenster für ${slot.apptType || slot.thema || 'uns'}:\n\n${labels.join('\n')}\n\nSag mir einfach, was dir passt! 🙌`;

    const phone = (slot.telefon || '').replace(/[^0-9+]/g, '').replace(/^0/, '49');
    if (!phone) { toast('Keine Telefonnummer für diese Anfrage hinterlegt.', 'error'); dlg.remove(); return; }

    dlg.remove();
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  };
}

window.deletePrivateSlot = async function(slotId) {
  if (!confirm('Private Anfrage ablehnen und löschen?')) return;
  try {
    await deleteDoc(doc(db, 'callSlots', slotId));
    toast('Anfrage abgelehnt.');
  } catch {
    privateSlots = privateSlots.filter(s => s.id !== slotId);
    renderDashboard();
    toast('Abgelehnt (offline).');
  }
};

window.deletePrivateSlotFromCal = async function(slotId) {
  const slot = privateSlots.find(s => s.id === slotId);
  const name = slot ? (slot.vorname || slot.bookedBy || 'Privater Termin') : 'Privater Termin';
  const status = slot?.status === 'confirmed' || slot?.type === 'fix' ? 'bestätigten ' : '';
  const hasGcal = slot?.gcalEventIds && Object.keys(slot.gcalEventIds).length > 0;
  const gcalHint = hasGcal ? '\n\nEr wird auch aus dem Google Kalender gelöscht.' : '';
  if (!confirm(`${status}privaten Termin für ${name} löschen?${gcalHint}\n\nDer Termin wird aus dem System entfernt.`)) return;
  if (hasGcal) {
    toast('Wird aus Google Kalender gelöscht…');
    const deleted = await deleteGCalEvents(slot.gcalEventIds);
    if (deleted > 0) {
      const deletedIds = Object.values(slot.gcalEventIds);
      googleCalendarEvents = googleCalendarEvents.filter(e => !deletedIds.includes(e.id));
    }
  }
  try {
    await deleteDoc(doc(db, 'callSlots', slotId));
    toast(hasGcal ? '✅ Privater Termin überall gelöscht!' : 'Privater Termin gelöscht.', hasGcal ? 'success' : undefined);
    if (hasGcal) setTimeout(() => loadGoogleCalendarEvents(), 1500);
  } catch {
    privateSlots = privateSlots.filter(s => s.id !== slotId);
    renderCalendar();
    toast('Termin gelöscht (offline).');
  }
};

// ============================================================
// GESCHÄFTLICHE TERMIN INBOX – Aktionen (NUR callSlots ohne privateBooking)
// ============================================================

// Bestätigt eine Mandanten-Anfrage: Status → fix/confirmed, Bestätigung per E-Mail/WhatsApp
window.confirmBusinessSlot = async function(slotId) {
  // Strikte Trennung: NUR in callSlots suchen, niemals in privateSlots
  const slot = callSlots.find(s => s.id === slotId);
  if (!slot) { toast('Anfrage nicht gefunden.', 'error'); return; }

  const dt    = new Date(slot.datetime);
  const dtEnd = new Date(dt.getTime() + (slot.apptDuration || 60) * 60000);
  const datum = dt.toLocaleDateString('de-DE', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  const von   = dt.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
  const bis   = dtEnd.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
  const settings = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const ownerName = settings.ownerName || 'Ihr Berater';

  // Auswahl-Modal für Benachrichtigungen
  const notifDlg = document.createElement('div');
  notifDlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:700;display:flex;align-items:center;justify-content:center;padding:20px;';
  notifDlg.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:18px;
      padding:26px 22px;width:100%;max-width:420px;animation:modalIn .2s ease;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <i class="ti ti-check-circle" style="font-size:22px;color:#10b981;"></i>
        <h2 style="font-size:16px;font-weight:700;">Termin bestätigen</h2>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:13px;line-height:1.7;color:var(--text2);">
        <strong style="color:var(--text);">${slot.vorname || ''} ${slot.nachname || ''}</strong><br>
        📅 ${datum}<br>
        🕐 ${von} – ${bis} Uhr
        ${slot.apptType ? `<br>🎯 ${slot.apptType}` : ''}
        ${slot.email ? `<br>📧 ${slot.email}` : ''}
        ${slot.telefon ? `<br>📞 ${slot.telefon}` : ''}
      </div>
      <div style="font-size:12px;font-weight:600;color:var(--purple);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;">
        Welche Benachrichtigungen sollen gesendet werden?
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;">
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;cursor:pointer;transition:background .15s;"
          onmouseover="this.style.background='rgba(16,185,129,0.08)'" onmouseout="this.style.background='var(--bg3)'">
          <input type="checkbox" id="bn_confirm" checked style="width:16px;height:16px;accent-color:#10b981;margin-top:1px;flex-shrink:0;" />
          <div>
            <div style="font-size:14px;font-weight:500;">📧 Terminbestätigung</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;">Versand: 1 Tag vor dem Termin</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;cursor:pointer;transition:background .15s;"
          onmouseover="this.style.background='rgba(245,158,11,0.08)'" onmouseout="this.style.background='var(--bg3)'">
          <input type="checkbox" id="bn_reminder" style="width:16px;height:16px;accent-color:var(--amber);margin-top:1px;flex-shrink:0;" />
          <div>
            <div style="font-size:14px;font-weight:500;">🔔 Terminerinnerung</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;">Versand: Am Termintag um 09:00 Uhr</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;cursor:pointer;transition:background .15s;"
          onmouseover="this.style.background='rgba(139,92,246,0.08)'" onmouseout="this.style.background='var(--bg3)'">
          <input type="checkbox" id="bn_notify" style="width:16px;height:16px;accent-color:var(--purple);margin-top:1px;flex-shrink:0;" />
          <div>
            <div style="font-size:14px;font-weight:500;">📲 Terminbenachrichtigung</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;">Versand: Sofort beim Eintragen</div>
          </div>
        </label>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="bn_cancel" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--border2);
          background:none;color:var(--text2);cursor:pointer;font-size:14px;font-family:inherit;">
          Abbrechen
        </button>
        <button id="bn_confirm_btn" style="flex:2;padding:11px;border-radius:10px;border:none;
          background:#10b981;color:#fff;cursor:pointer;font-size:14px;font-weight:700;font-family:inherit;
          display:flex;align-items:center;justify-content:center;gap:7px;">
          <i class="ti ti-check"></i> Bestätigen & Senden
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(notifDlg);

  document.getElementById('bn_cancel').onclick = () => notifDlg.remove();

  document.getElementById('bn_confirm_btn').onclick = async () => {
    const sendConfirm = document.getElementById('bn_confirm').checked;
    const sendReminder = document.getElementById('bn_reminder').checked;
    const sendNotify = document.getElementById('bn_notify').checked;
    notifDlg.remove();

    try {
      await updateDoc(doc(db, 'callSlots', slotId), {
        type:        'fix',
        status:      'confirmed',
        confirmedAt: serverTimestamp(),
        notifications: { confirm: sendConfirm, reminder: sendReminder, notify: sendNotify },
      });
      // Kontakt-Status aktualisieren
      if (slot.contactId) {
        await updateDoc(doc(db, 'contacts', slot.contactId), {
          status: 'termin',
          type: 'business',
        }).catch(() => {});
      }
      toast(`✅ Termin für ${slot.vorname} bestätigt!`, 'success');
    } catch(e) {
      console.warn('Firestore update fehlgeschlagen (Bestätigung):', e);
      const idx = callSlots.findIndex(s => s.id === slotId);
      if (idx !== -1) { callSlots[idx].type = 'fix'; callSlots[idx].status = 'confirmed'; }
      toast('Termin bestätigt (offline).', 'success');
      renderDashboard();
    }

    // Google Kalender Sync
    try {
      await syncToGoogleCalendar(
        { ...slot, apptType: slot.apptType || slot.thema || 'Beratungstermin', apptDuration: slot.apptDuration || 60, apptColor: '#6366f1', note: `Mandant: ${slot.vorname} ${slot.nachname || ''}${slot.notizen ? ' – ' + slot.notizen : ''}` },
        { vorname: slot.vorname || '', nachname: slot.nachname || '', telefon: slot.telefon || '' }
      );
    } catch(e) { console.warn('GCal sync fehlgeschlagen:', e.message); }

    // Benachrichtigungen senden – per E-Mail (aus Einstellungen-Templates)
    const contactObj = {
      vorname:  slot.vorname  || '',
      nachname: slot.nachname || '',
      email:    slot.email    || '',
      telefon:  slot.telefon  || '',
    };
    const slotObj = { datetime: slot.datetime, apptType: slot.apptType || 'Beratungsgespräch', apptDuration: slot.apptDuration || 60 };

    if (contactObj.email) {
      // Alle Flags direkt per slotId setzen – kein Re-Query nötig
      try {
        const flagUpdate = {};
        if (sendConfirm)  flagUpdate.sendConfirmEmail = true;
        if (sendReminder) flagUpdate.sendReminder     = true;
        if (Object.keys(flagUpdate).length > 0) {
          await updateDoc(doc(db, 'callSlots', slotId), flagUpdate);
        }
      } catch(fe) { console.warn('Flag-Update fehlgeschlagen:', fe.message); }

      if (sendConfirm)  toast('📬 Bestätigung wird 1 Tag vor dem Termin automatisch per E-Mail versendet.', 'success');
      if (sendReminder) toast('🔔 Erinnerung am Termintag wird automatisch per E-Mail versendet.', 'success');

      if (sendNotify) {
        // Sofortige Benachrichtigungs-E-Mail mit Kalender-Einladung (.ics)
        await sendConfirmationEmail(contactObj, { ...slotObj, mailType: 'notify', withIcs: true });
      }
    } else if (sendConfirm && slot.telefon) {
      // Fallback WhatsApp wenn keine E-Mail hinterlegt
      const phone = slot.telefon.replace(/[^0-9+]/g, '').replace(/^0/, '49');
      const msg = `Hallo ${slot.vorname} 👋\n\nhiermit bestätige ich Ihren Termin:\n📅 ${datum}\n🕐 ${von} – ${bis} Uhr\n🎯 ${slot.apptType || 'Beratungsgespräch'}\n\nBis dann! 🤝`;
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
    }
  };
};

// Alternativtermine für Mitarbeiter-Anfragen anbieten
window.offerStaffAlternatives = function(slotId) {
  const slot = callSlots.find(s => s.id === slotId);
  if (!slot) { toast('Anfrage nicht gefunden.', 'error'); return; }
  const takenSlots = [...callSlots.filter(s => s.id !== slotId), ...privateSlots];
  // isStaff-Flag: Kalender zeigt Arbeitstage, Nachricht ist per-du (intern)
  openAltPickerModal({ slot, isPrivate: false, takenSlots, isStaff: true });
};

// Alternativtermine für Mandanten anbieten – Kalender-Picker
window.offerBusinessAlternatives = function(slotId) {
  const slot = callSlots.find(s => s.id === slotId);
  if (!slot) { toast('Anfrage nicht gefunden.', 'error'); return; }
  const takenSlots = [...callSlots.filter(s => s.id !== slotId), ...privateSlots];
  openAltPickerModal({ slot, isPrivate: false, takenSlots });
};

function showBusinessAlternativesModal(slot, freeSlots) {
  document.getElementById('businessAltModal')?.remove();

  const fmtSlot = d => {
    const datum = d.toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'short' });
    const von   = d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    const bis   = new Date(d.getTime() + (slot.apptDuration || 60) * 60000)
                    .toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
    return `${datum}, ${von}–${bis} Uhr`;
  };

  const slotItems = freeSlots.length === 0
    ? `<p style="color:var(--text3);font-size:13px;text-align:center;padding:12px 0;">Keine freien Zeitfenster in den nächsten 14 Tagen gefunden.</p>`
    : freeSlots.map(s => `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;
        background:var(--bg3);border:1px solid var(--border2);border-radius:8px;cursor:pointer;
        transition:background .15s;" onmouseover="this.style.background='rgba(99,102,241,0.08)'" onmouseout="this.style.background='var(--bg3)'">
        <input type="checkbox" class="biz-alt-slot-check" value="${s.toISOString()}" data-label="${fmtSlot(s)}"
          style="width:16px;height:16px;accent-color:var(--purple);" />
        <span style="font-size:14px;">${fmtSlot(s)}</span>
      </label>`).join('');

  const dlg = document.createElement('div');
  dlg.id = 'businessAltModal';
  dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:600;display:flex;align-items:center;justify-content:center;padding:20px;';
  dlg.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:18px;
      padding:26px 22px;width:100%;max-width:440px;animation:modalIn .2s ease;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <h2 style="font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px;">
          <i class="ti ti-calendar-search" style="color:var(--purple);"></i>
          Alternativtermine für ${slot.vorname} ${slot.nachname || ''}
        </h2>
        <button onclick="document.getElementById('businessAltModal').remove()"
          style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:20px;">
          <i class="ti ti-x"></i>
        </button>
      </div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;line-height:1.5;">
        Wähle bis zu <strong>2 freie Zeitfenster</strong> aus (Mo–Fr, Geschäftszeiten),
        die du ${slot.vorname} anbieten möchtest.
      </p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;" id="bizAltSlotList">
        ${slotItems}
      </div>
      <div id="bizAltSelectionInfo" style="font-size:12px;color:var(--text3);margin-bottom:12px;min-height:16px;"></div>
      <div style="display:flex;gap:8px;">
        <button id="bizAltCancelBtn" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border2);
          background:none;color:var(--text2);cursor:pointer;font-size:14px;font-family:inherit;">
          Abbrechen
        </button>
        ${slot.email ? `
        <button id="bizAltEmailBtn" style="flex:1;padding:10px;border-radius:10px;border:none;
          background:rgba(99,102,241,0.15);color:var(--purple);cursor:pointer;font-size:14px;font-weight:600;font-family:inherit;
          display:flex;align-items:center;justify-content:center;gap:7px;">
          <i class="ti ti-mail"></i> Per E-Mail
        </button>` : ''}
        ${slot.telefon ? `
        <button id="bizAltWaBtn" style="flex:2;padding:10px;border-radius:10px;border:none;
          background:var(--purple);color:#fff;cursor:pointer;font-size:14px;font-weight:700;font-family:inherit;
          display:flex;align-items:center;justify-content:center;gap:7px;">
          <i class="ti ti-brand-whatsapp"></i> Per WhatsApp
        </button>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
  document.getElementById('bizAltCancelBtn').onclick = () => dlg.remove();

  const info = document.getElementById('bizAltSelectionInfo');
  dlg.querySelectorAll('.biz-alt-slot-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = [...dlg.querySelectorAll('.biz-alt-slot-check:checked')];
      if (checked.length > 2) { cb.checked = false; return; }
      info.textContent = checked.length === 0 ? '' : `${checked.length} von 2 ausgewählt`;
    });
  });

  const getMsg = () => {
    const checked = [...dlg.querySelectorAll('.biz-alt-slot-check:checked')];
    if (checked.length === 0) { toast('Bitte mindestens einen Slot auswählen.', 'error'); return null; }
    const labels = checked.map(c => '📅 ' + c.dataset.label);
    return `Guten Tag ${slot.vorname},\n\nder gewünschte Termin ist leider nicht verfügbar. Ich biete Ihnen folgende freie Zeitfenster an:\n\n${labels.join('\n')}\n\nBitte teilen Sie mir mit, welcher Termin für Sie passt.\n\nMit freundlichen Grüßen`;
  };

  if (document.getElementById('bizAltEmailBtn')) {
    document.getElementById('bizAltEmailBtn').onclick = () => {
      const msg = getMsg(); if (!msg) return;
      const subject = encodeURIComponent(`Alternativtermine für Ihr Anliegen`);
      dlg.remove();
      window.open(`mailto:${slot.email}?subject=${subject}&body=${encodeURIComponent(msg)}`, '_blank');
    };
  }
  if (document.getElementById('bizAltWaBtn')) {
    document.getElementById('bizAltWaBtn').onclick = () => {
      const msg = getMsg(); if (!msg) return;
      const phone = (slot.telefon || '').replace(/[^0-9+]/g, '').replace(/^0/, '49');
      if (!phone) { toast('Keine Telefonnummer hinterlegt.', 'error'); dlg.remove(); return; }
      dlg.remove();
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
    };
  }
}

window.deleteBusinessSlot = async function(slotId) {
  if (!confirm('Mandanten-Anfrage ablehnen und löschen?')) return;
  try {
    await deleteDoc(doc(db, 'callSlots', slotId));
    toast('Anfrage abgelehnt.');
  } catch {
    callSlots = callSlots.filter(s => s.id !== slotId);
    renderDashboard();
    toast('Abgelehnt (offline).');
  }
};

// ============================================================
// AUTH – Google Login
// ============================================================

// Deine erlaubte Google-E-Mail (nur diese kommt rein)
const ALLOWED_EMAIL = "nawin.telis@gmail.com";

function showLoginScreen() {
  document.getElementById('auth-loading')?.remove();
  document.getElementById('content').innerHTML = '';
  document.getElementById('pageTitle').textContent = 'Lead Tracker';

  const loginDiv = document.createElement('div');
  loginDiv.id = 'login-screen';
  loginDiv.style.cssText = `
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    min-height:70vh;gap:24px;text-align:center;
  `;
  loginDiv.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:20px;
      padding:48px 40px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
      <div style="font-size:48px;margin-bottom:16px;">🔐</div>
      <h2 style="font-size:22px;font-weight:700;margin-bottom:8px;color:var(--text);">Lead Tracker</h2>
      <p style="font-size:14px;color:var(--text3);margin-bottom:32px;">
        Privater Zugang – nur für autorisierte Nutzer
      </p>
      <button id="google-login-btn" style="
        display:flex;align-items:center;justify-content:center;gap:12px;
        width:100%;padding:13px 20px;border-radius:12px;border:1px solid var(--border2);
        background:var(--bg3);color:var(--text);font-size:15px;font-weight:500;
        cursor:pointer;transition:all 0.2s;font-family:inherit;
      ">
        <svg width="20" height="20" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Mit Google anmelden
      </button>
      <p id="login-error" style="margin-top:16px;font-size:12px;color:var(--red);display:none;"></p>
    </div>
  `;
  document.body.appendChild(loginDiv);

  document.getElementById('google-login-btn').addEventListener('click', async () => {
    const btn = document.getElementById('google-login-btn');
    btn.textContent = 'Anmelden...';
    btn.disabled = true;
    try {
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        const tokenData = JSON.stringify({
          token: credential.accessToken,
          expires: Date.now() + 3600000, // ~1h, wie bei Google OAuth-Tokens üblich
        });
        localStorage.setItem('gmailOAuthToken', tokenData);
        localStorage.setItem('gcalOAuthToken_' + result.user.email, tokenData);
      }
    } catch (e) {
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Mit Google anmelden`;
      btn.disabled = false;
      const err = document.getElementById('login-error');
      err.textContent = 'Anmeldung fehlgeschlagen. Bitte erneut versuchen.';
      err.style.display = 'block';
    }
  });
}

function hideLoginScreen() {
  document.getElementById('auth-loading')?.remove();
  document.getElementById('login-screen')?.remove();
}

function showLogoutBtn(user) {
  document.getElementById('topAddBtn').insertAdjacentHTML('beforebegin', `
    <div id="user-info" style="display:flex;align-items:center;gap:6px;margin-right:4px;flex-wrap:wrap;">
      <img src="${user.photoURL || ''}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:2px solid var(--border2);" onerror="this.style.display='none'"/>
      <button id="private-link-btn" title="Privater Buchungslink" onclick="generatePrivateBookingLink()" style="
        background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.35);color:var(--amber);
        border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;
        font-family:inherit;transition:all 0.15s;display:flex;align-items:center;gap:5px;
      "><i class="ti ti-lock" style="font-size:13px;"></i> Privat</button>
      <button id="public-link-btn" title="Öffentlicher Buchungslink" onclick="generatePublicBookingLink()" style="
        background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.35);color:var(--purple);
        border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;
        font-family:inherit;transition:all 0.15s;display:flex;align-items:center;gap:5px;
      "><i class="ti ti-link" style="font-size:13px;"></i> Buchung</button>
      <button id="staff-link-btn" title="Allgemeiner Mitarbeiter-Buchungslink" onclick="generateStaffBookingLink()" style="
        background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.35);color:#10b981;
        border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;
        font-family:inherit;transition:all 0.15s;display:flex;align-items:center;gap:5px;
      "><i class="ti ti-users" style="font-size:13px;"></i> Team</button>
      <button id="logout-btn" title="Abmelden" style="
        background:none;border:1px solid var(--border2);color:var(--text3);
        border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;
        font-family:inherit;transition:all 0.15s;
      ">Abmelden</button>
    </div>
  `);
  document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));
}

function hideLogoutBtn() {
  document.getElementById('user-info')?.remove();
}

// Auth State Observer – steuert alles
// ── Robuster Fallback: 3 Stufen gegen hängenden Auth-Screen ──────────────────

let _authResolved = false;

// Stufe 1: Nach 5s Ladetext aktualisieren
const _authWarnTimeout = setTimeout(() => {
  if (_authResolved) return;
  const loadingEl = document.getElementById('auth-loading');
  if (loadingEl) {
    const msgEl = loadingEl.querySelector('#auth-loading-msg') || loadingEl.querySelector('p') || loadingEl.querySelector('span');
    if (msgEl) msgEl.textContent = 'Verbindung wird aufgebaut…';
  }
}, 5000);

// Stufe 2: Nach 12s Login-Screen erzwingen (Firebase braucht bei schlechter Verbindung länger)
const _authTimeout = setTimeout(() => {
  if (_authResolved) return;
  console.warn('Firebase Auth Timeout – Login-Screen wird angezeigt');
  _authResolved = true;
  clearTimeout(_authWarnTimeout);
  showLoginScreen();
}, 12000);

// Stufe 3: Absoluter Notfall-Fallback nach 20s
const _authNuclear = setTimeout(() => {
  document.getElementById('auth-loading')?.remove();
  if (!document.getElementById('login-screen')) showLoginScreen();
}, 20000);

onAuthStateChanged(auth, (user) => {
  // Always handle logout/no-user, even if timeout already fired
  if (_authResolved && !user) {
    hideLogoutBtn();
    showLoginScreen();
    return;
  }
  _authResolved = true;
  clearTimeout(_authWarnTimeout);
  clearTimeout(_authTimeout);
  clearTimeout(_authNuclear);

  if (user) {
    // Prüfen ob E-Mail erlaubt ist
    if (user.email !== ALLOWED_EMAIL) {
      signOut(auth);
      showLoginScreen();
      setTimeout(() => {
        const err = document.getElementById('login-error');
        if (err) {
          err.textContent = `Zugriff verweigert: ${user.email} ist nicht autorisiert.`;
          err.style.display = 'block';
        }
      }, 100);
      return;
    }
    hideLoginScreen();
    showLogoutBtn(user);
    window.navigate = navigate;
    loadContacts();
    loadCallSlots();
    loadGoogleCalendarEvents();
    renderDashboard();
  } else {
    hideLogoutBtn();
    showLoginScreen();
  }
});
// ============================================================
// ERWEITERUNGEN – app-extensions.js
// Diesen Code am Ende von app.js einfügen (vor der letzten
// schließenden Klammer falls vorhanden, sonst einfach anhängen).
//
// Enthält:
//  1. Kontakt-Kategorien (Mandant / Privat / Mitarbeiter / Mandant von Mitarbeiter)
//     + flexibles Umbenennen in den Einstellungen
//  2. Erweitertes Mitarbeiter-Booking: optionales Mandanten-Feld
//  3. Automatische WhatsApp/E-Mail-Vorlage nach Dreier-Termin-Bestätigung
// ============================================================


// ============================================================
// 1A. KONTAKT-KATEGORIEN – Hilfsfunktionen
// ============================================================

/** Gibt die aktuellen Kategorie-Labels aus den Settings zurück. */
function getCategoryLabels() {
  const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  return {
    mandant:           s.catLabelMandant           || 'Mandant',
    privat:            s.catLabelPrivat            || 'Privat',
    mitarbeiter:       s.catLabelMitarbeiter       || 'Mitarbeiter',
    mandantMitarbeiter:s.catLabelMandantMitarbeiter|| 'Mandant von Mitarbeiter',
  };
}

/**
 * Weist einem Kontakt die Kategorie zu.
 * category: 'mandant' | 'privat' | 'mitarbeiter' | 'mandantMitarbeiter' | null
 */
window.setContactCategory = async function(contactId, category) {
  try {
    await updateDoc(doc(db, 'contacts', contactId), { contactCategory: category || null });
    toast('Kategorie gespeichert!');
  } catch {
    const idx = contacts.findIndex(c => c.id === contactId);
    if (idx !== -1) contacts[idx].contactCategory = category || null;
    toast('Kategorie gespeichert (offline).');
  }
};

/** Gibt das passende Badge-HTML für eine Kategorie zurück. */
function categoryBadge(category) {
  if (!category) return '';
  const labels = getCategoryLabels();
  const map = {
    mandant:            { label: labels.mandant,            color: '#6366f1', icon: 'ti-briefcase'  },
    privat:             { label: labels.privat,             color: '#f59e0b', icon: 'ti-heart'      },
    mitarbeiter:        { label: labels.mitarbeiter,        color: '#8b5cf6', icon: 'ti-users'       },
    mandantMitarbeiter: { label: labels.mandantMitarbeiter, color: '#10b981', icon: 'ti-user-plus'   },
  };
  const c = map[category];
  if (!c) return '';
  return `<span style="
    display:inline-flex;align-items:center;gap:4px;
    font-size:11px;font-weight:600;border-radius:4px;padding:1px 6px;
    background:${c.color}22;color:${c.color};border:1px solid ${c.color}55;
  "><i class="ti ${c.icon}" style="font-size:11px;"></i>${c.label}</span>`;
}


// ============================================================
// 1C. EINSTELLUNGEN – Kategorie-Labels (in renderSettings einhaken)
// ============================================================

/**
 * Gibt den HTML-Block für die Kategorie-Einstellungen zurück.
 * Wird in renderSettings() injiziert – vor dem saveSettings-Button.
 */
function buildCategorySettingsHTML(s) {
  const labels = getCategoryLabels();
  return `
    <!-- ── KONTAKT-KATEGORIEN ── -->
    <div class="settings-section" id="categorySettingsSection">
      <h3><i class="ti ti-tag" style="margin-right:6px;"></i>Kontakt-Kategorien</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">
        Benenne die vier Kontaktkategorien nach deinen Bedürfnissen um.
        Die Namen erscheinen überall in der App (Filter-Tabs, Badges, Vorlagen).
      </p>
      <div class="form-grid">
        <div class="field">
          <label style="display:flex;align-items:center;gap:6px;">
            <span style="width:10px;height:10px;border-radius:3px;background:#6366f1;display:inline-block;"></span>
            Kategorie 1 – Mandant
          </label>
          <input type="text" id="s_catLabelMandant"
            value="${s.catLabelMandant || 'Mandant'}"
            placeholder="z.B. Mandant" />
        </div>
        <div class="field">
          <label style="display:flex;align-items:center;gap:6px;">
            <span style="width:10px;height:10px;border-radius:3px;background:#f59e0b;display:inline-block;"></span>
            Kategorie 2 – Privat
          </label>
          <input type="text" id="s_catLabelPrivat"
            value="${s.catLabelPrivat || 'Privat'}"
            placeholder="z.B. Privat / Freunde" />
        </div>
        <div class="field">
          <label style="display:flex;align-items:center;gap:6px;">
            <span style="width:10px;height:10px;border-radius:3px;background:#8b5cf6;display:inline-block;"></span>
            Kategorie 3 – Mitarbeiter
          </label>
          <input type="text" id="s_catLabelMitarbeiter"
            value="${s.catLabelMitarbeiter || 'Mitarbeiter'}"
            placeholder="z.B. Mitarbeiter / Empfehlungsmanager" />
        </div>
        <div class="field">
          <label style="display:flex;align-items:center;gap:6px;">
            <span style="width:10px;height:10px;border-radius:3px;background:#10b981;display:inline-block;"></span>
            Kategorie 4 – Mandant von Mitarbeiter
          </label>
          <input type="text" id="s_catLabelMandantMitarbeiter"
            value="${s.catLabelMandantMitarbeiter || 'Mandant von Mitarbeiter'}"
            placeholder="z.B. Mandant von Empfehlungsmanager" />
        </div>
      </div>
      <p style="font-size:12px;color:var(--text3);margin-top:8px;">
        <i class="ti ti-info-circle"></i>
        Tipp: Kategorie 4 eignet sich für Mandanten, die über einen Empfehlungsmanager vermittelt wurden.
      </p>
    </div>
  `;
}

// ── Monkey-Patch renderSettings: Kategorie-Sektion + Speichern erweitern ──
const _origRenderSettings = renderSettings;

function buildAltTemplateSettingsHTML(s) {
  const defMandant     = `Guten Tag {vorname},\n\nder von Ihnen gew\xc3\xbcnschte Termin ist leider nicht verf\xc3\xbcgbar. Ich biete Ihnen gerne folgende Alternativtermine an:\n\n{termine}\n\nBitte teilen Sie mir mit, welcher Termin f\xc3\xbcr Sie passt.\n\nMit freundlichen Gr\xc3\xbc\xc3\x9fen\n{gruss}`;
  const defPrivat      = `Hey {vorname} \xf0\x9f\x91\x8b\n\nder gew\xc3\xbcnschte Termin klappt leider nicht. Ich habe aber noch folgende freie Zeitfenster:\n\n{termine}\n\nSag mir einfach, was dir passt! \xf0\x9f\x99\x8c\n{gruss}`;
  const defMitarbeiter = `Hallo {vorname},\n\nder angefragte Termin ist leider belegt. Ich schlage folgende Alternativen vor:\n\n{termine}\n\nBitte kurz R\xc3\xbcckmeldung, welcher Termin passt.\n\nViele Gr\xc3\xbc\xc3\x9fe\n{gruss}`;
  return `
    <!-- \u2500\u2500 ALTERNATIVTERMIN-VORLAGEN \u2500\u2500 -->
    <div class="settings-section" id="altTemplateSettingsSection">
      <h3><i class="ti ti-mail" style="margin-right:6px;"></i>E-Mail-Vorlagen \u2013 Alternativtermine</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:6px;line-height:1.5;">
        Diese Texte werden vorausgef\xc3\xbcllt, wenn du bei einer Anfrage auf <strong>\u201eAlternativen anbieten\u201c</strong> klickst.
        Du kannst den Text vor dem Senden noch anpassen.
      </p>
      <p style="font-size:12px;color:var(--text3);margin-bottom:16px;">
        Platzhalter: <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{vorname}</code>
        <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{nachname}</code>
        <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{termine}</code>
        <code style="background:var(--bg3);padding:1px 5px;border-radius:4px;">{gruss}</code> (dein Name aus Einstellungen)
      </p>
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="field full">
          <label style="display:flex;align-items:center;gap:6px;">
            <span style="width:10px;height:10px;border-radius:3px;background:#6366f1;display:inline-block;"></span>
            Vorlage f\xc3\xbcr <strong>Mandanten</strong> (formell)
          </label>
          <textarea id="s_altTemplateMandant" rows="6"
            style="background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:8px;
            padding:10px 12px;font-size:13px;font-family:inherit;width:100%;resize:vertical;line-height:1.6;"
            placeholder="Vorlage f\xc3\xbcr Mandanten...">${s.altTemplateMandant || defMandant}</textarea>
        </div>
        <div class="field full">
          <label style="display:flex;align-items:center;gap:6px;">
            <span style="width:10px;height:10px;border-radius:3px;background:#f59e0b;display:inline-block;"></span>
            Vorlage f\xc3\xbcr <strong>Private Kontakte</strong> (per du)
          </label>
          <textarea id="s_altTemplatePrivat" rows="6"
            style="background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:8px;
            padding:10px 12px;font-size:13px;font-family:inherit;width:100%;resize:vertical;line-height:1.6;"
            placeholder="Vorlage f\xc3\xbcr private Kontakte...">${s.altTemplatePrivat || defPrivat}</textarea>
        </div>
        <div class="field full">
          <label style="display:flex;align-items:center;gap:6px;">
            <span style="width:10px;height:10px;border-radius:3px;background:#8b5cf6;display:inline-block;"></span>
            Vorlage f\xc3\xbcr <strong>Mitarbeiter-Anfragen</strong>
          </label>
          <textarea id="s_altTemplateMitarbeiter" rows="6"
            style="background:var(--bg2);border:1px solid var(--border2);color:var(--text);border-radius:8px;
            padding:10px 12px;font-size:13px;font-family:inherit;width:100%;resize:vertical;line-height:1.6;"
            placeholder="Vorlage f\xc3\xbcr Mitarbeiter-Anfragen...">${s.altTemplateMitarbeiter || defMitarbeiter}</textarea>
        </div>
      </div>
      <p style="font-size:12px;color:var(--text3);margin-top:10px;">
        <i class="ti ti-info-circle"></i>
        Die Vorlagen werden lokal gespeichert und erscheinen vorausgef\xc3\xbcllt im Sende-Dialog.
      </p>
    </div>
  `;
}

function _extRenderSettings() {
  _origRenderSettings();

  requestAnimationFrame(() => {
    const s = JSON.parse(localStorage.getItem('crmSettings') || '{}');

    // ── E-Mail-Vorlagen DIREKT nach Terminerinnerung einfügen ──
    if (!document.getElementById('altTemplateSettingsSection')) {
      // Terminerinnerung-Sektion finden: enthält den s_emailReminderText textarea
      const reminderTextarea = document.getElementById('s_emailReminderText');
      const reminderSection  = reminderTextarea?.closest('.settings-section');
      if (reminderSection) {
        reminderSection.insertAdjacentHTML('afterend', buildAltTemplateSettingsHTML(s));
      } else {
        // Fallback: vor Save-Button
        document.getElementById('saveSettings')?.parentElement
          .insertAdjacentHTML('beforebegin', buildAltTemplateSettingsHTML(s));
      }
    }

    // ── Kontaktkategorien DIREKT nach Terminarten für Mitarbeiter einfügen ──
    if (!document.getElementById('categorySettingsSection')) {
      // Mitarbeiter-Terminarten-Sektion finden: enthält addStaffApptType button
      const staffBtn = document.getElementById('addStaffApptType');
      const staffSection = staffBtn?.closest('.settings-section');
      if (staffSection) {
        staffSection.insertAdjacentHTML('afterend', buildCategorySettingsHTML(s));
      } else {
        document.getElementById('saveSettings')?.parentElement
          .insertAdjacentHTML('beforebegin', buildCategorySettingsHTML(s));
      }
    }

    // ── Speichern-Button: alle Felder mitspeichern ──
    const saveBtn = document.getElementById('saveSettings');
    if (saveBtn && !saveBtn._catPatched) {
      saveBtn._catPatched = true;
      saveBtn.addEventListener('click', () => {
        const existing = JSON.parse(localStorage.getItem('crmSettings') || '{}');
        existing.catLabelMandant            = document.getElementById('s_catLabelMandant')?.value.trim()            || 'Mandant';
        existing.catLabelPrivat             = document.getElementById('s_catLabelPrivat')?.value.trim()             || 'Privat';
        existing.catLabelMitarbeiter        = document.getElementById('s_catLabelMitarbeiter')?.value.trim()        || 'Mitarbeiter';
        existing.catLabelMandantMitarbeiter = document.getElementById('s_catLabelMandantMitarbeiter')?.value.trim() || 'Mandant von Mitarbeiter';
        const tM  = document.getElementById('s_altTemplateMandant');
        const tP  = document.getElementById('s_altTemplatePrivat');
        const tMa = document.getElementById('s_altTemplateMitarbeiter');
        if (tM)  existing.altTemplateMandant     = tM.value;
        if (tP)  existing.altTemplatePrivat      = tP.value;
        if (tMa) existing.altTemplateMitarbeiter = tMa.value;
        localStorage.setItem('crmSettings', JSON.stringify(existing));
      }, { capture: false });
    }
  });
}

// Seiten-Navigation überschreiben um die neue renderSettings zu nutzen
const _pagesRef = typeof pages !== 'undefined' ? pages : null;
if (_pagesRef && _pagesRef.settings) {
  _pagesRef.settings.render = _extRenderSettings;
}


// ============================================================
// 2. STAFF-INBOX: MANDANTEN-ZUORDNUNG anzeigen & bestätigen
// ============================================================

/**
 * Überschreibt confirmStaffSlot so, dass nach der Bestätigung
 * automatisch die Textvorlage (Feature 3) angeboten wird.
 * Original-Funktion bleibt erhalten.
 */
const _origConfirmStaffSlot = window.confirmStaffSlot;

window.confirmStaffSlot = async function(slotId) {
  // Zuerst Original-Bestätigung ausführen
  if (_origConfirmStaffSlot) {
    await _origConfirmStaffSlot(slotId);
  } else {
    // Fallback: direkt in Firestore bestätigen
    try {
      await updateDoc(doc(db, 'callSlots', slotId), {
        status: 'bestätigt',
        type: 'fix',
        confirmedAt: new Date().toISOString(),
      });
      toast('Termin bestätigt!');
    } catch {
      const idx = callSlots.findIndex(s => s.id === slotId);
      if (idx !== -1) {
        callSlots[idx].status = 'bestätigt';
        callSlots[idx].type   = 'fix';
      }
      toast('Termin bestätigt (offline).');
    }
  }

  // Textvorlage anbieten wenn Mandanten-Verknüpfung vorhanden
  const slot = callSlots.find(s => s.id === slotId);
  if (slot?.linkedMandantId) {
    setTimeout(() => openThreewayTemplate(slotId), 400);
  }
};


// ============================================================
// 3. TEXTVORLAGE – Dreier-Gespräch (Mitarbeiter + Mandant)
// ============================================================

/**
 * Öffnet einen Modal-Dialog mit der generierten Textvorlage
 * für den verknüpften Mandanten.
 */
window.openThreewayTemplate = function(slotId) {
  const slot = [...callSlots, ...privateSlots].find(s => s.id === slotId);
  if (!slot) { toast('Termin nicht gefunden.', 'error'); return; }

  const mandant = slot.linkedMandantId
    ? contacts.find(c => c.id === slot.linkedMandantId)
    : null;

  const mitarbeiterName = `${slot.vorname || ''} ${slot.nachname || ''}`.trim();

  const dt      = new Date(slot.datetime);
  const weekday = dt.toLocaleDateString('de-DE', { weekday: 'long' });
  const datum   = dt.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  const uhrzeit = dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  const mandantVorname = mandant?.vorname || '[Name des Mandanten]';
  const mandantEmail   = mandant?.email   || '';
  const mandantTelefon = mandant?.telefon ? mandant.telefon.replace(/[^0-9+]/g, '').replace(/^0/, '49') : '';
  const terminartLabel  = slot.apptType   || 'Beratungsgespräch';

  // ── Textvorlage generieren ──
  const textWA = generateThreewayText({
    mandantVorname,
    mitarbeiterName,
    weekday,
    datum,
    uhrzeit,
    terminart: terminartLabel,
    channel: 'whatsapp',
  });
  const textEmail = generateThreewayText({
    mandantVorname,
    mitarbeiterName,
    weekday,
    datum,
    uhrzeit,
    terminart: terminartLabel,
    channel: 'email',
  });

  // ── Modal rendern ──
  const existingModal = document.getElementById('threewayTemplateModal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'threewayTemplateModal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);padding:16px;
  `;
  modal.innerHTML = `
    <div style="
      background:var(--bg2);border:1px solid var(--border2);border-radius:16px;
      max-width:540px;width:100%;max-height:88vh;overflow-y:auto;padding:28px 24px;
      box-shadow:0 24px 60px rgba(0,0,0,0.5);position:relative;
    ">
      <button onclick="document.getElementById('threewayTemplateModal').remove()"
        style="position:absolute;top:14px;right:14px;background:none;border:none;
        color:var(--text3);cursor:pointer;font-size:22px;line-height:1;padding:4px;">
        <i class="ti ti-x"></i>
      </button>

      <div style="margin-bottom:20px;">
        <h2 style="font-size:17px;font-weight:700;margin-bottom:4px;">
          <i class="ti ti-message-share" style="color:var(--purple);margin-right:6px;"></i>
          Textvorlage – Dreier-Termin
        </h2>
        <p style="font-size:13px;color:var(--text3);">
          Termin mit <strong style="color:var(--text2);">${mitarbeiterName}</strong>
          ${mandant ? `& Mandant <strong style="color:var(--text2);">${mandant.vorname} ${mandant.nachname}</strong>` : ''}
          · ${weekday}, ${datum} · ${uhrzeit} Uhr
        </p>
      </div>

      <!-- Tabs -->
      <div style="display:flex;gap:8px;margin-bottom:16px;">
        <button id="twTab_wa" onclick="twShowTab('wa')"
          style="flex:1;padding:8px;border-radius:8px;border:1.5px solid rgba(37,211,102,0.5);
          background:rgba(37,211,102,0.1);color:#25d366;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">
          <i class="ti ti-brand-whatsapp"></i> WhatsApp
        </button>
        <button id="twTab_email" onclick="twShowTab('email')"
          style="flex:1;padding:8px;border-radius:8px;border:1.5px solid var(--border2);
          background:transparent;color:var(--text2);font-size:13px;cursor:pointer;font-family:inherit;">
          <i class="ti ti-mail"></i> E-Mail
        </button>
      </div>

      <!-- WhatsApp Vorlage -->
      <div id="twContent_wa">
        <div style="position:relative;">
          <textarea id="twText_wa" rows="11"
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);
            border-radius:10px;padding:14px;font-size:13px;line-height:1.6;outline:none;
            font-family:inherit;resize:vertical;"
          >${textWA}</textarea>
          <button onclick="copyTwText('wa')"
            style="position:absolute;top:8px;right:8px;background:rgba(37,211,102,0.15);
            border:1px solid rgba(37,211,102,0.35);color:#25d366;border-radius:6px;
            padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;">
            <i class="ti ti-copy"></i> Kopieren
          </button>
        </div>
        ${mandantTelefon ? `
        <button onclick="openWhatsApp('${mandantTelefon}', 'wa')"
          style="margin-top:10px;width:100%;padding:11px;border-radius:10px;border:none;
          background:#25d366;color:#fff;font-size:14px;font-weight:600;cursor:pointer;
          font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;">
          <i class="ti ti-brand-whatsapp"></i> Direkt in WhatsApp öffnen
        </button>` : `
        <p style="font-size:12px;color:var(--text3);margin-top:8px;">
          <i class="ti ti-info-circle"></i> Keine Telefonnummer für diesen Mandanten hinterlegt.
        </p>`}
      </div>

      <!-- E-Mail Vorlage -->
      <div id="twContent_email" style="display:none;">
        <div style="position:relative;">
          <textarea id="twText_email" rows="11"
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);
            border-radius:10px;padding:14px;font-size:13px;line-height:1.6;outline:none;
            font-family:inherit;resize:vertical;"
          >${textEmail}</textarea>
          <button onclick="copyTwText('email')"
            style="position:absolute;top:8px;right:8px;background:rgba(59,130,246,0.15);
            border:1px solid rgba(59,130,246,0.35);color:var(--accent);border-radius:6px;
            padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;">
            <i class="ti ti-copy"></i> Kopieren
          </button>
        </div>
        ${mandantEmail ? `
        <button onclick="openEmailClient('${mandantEmail}', 'email', '${mitarbeiterName}', '${datum}')"
          style="margin-top:10px;width:100%;padding:11px;border-radius:10px;border:none;
          background:var(--accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;
          font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;">
          <i class="ti ti-mail"></i> E-Mail-Client öffnen
        </button>` : ''}
        <p style="font-size:12px;color:var(--text3);margin-top:8px;">
          <i class="ti ti-info-circle"></i>
          Die .ics-Kalender-Datei wird bei der Termin-Bestätigungsmail automatisch mitgeschickt.
        </p>
      </div>

    </div>
  `;
  document.body.appendChild(modal);

  // Klick außerhalb schließt Modal
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
};

/** Generiert den Vorlagentext für WhatsApp oder E-Mail. */
function generateThreewayText({ mandantVorname, mitarbeiterName, weekday, datum, uhrzeit, terminart, channel }) {
  const s          = JSON.parse(localStorage.getItem('crmSettings') || '{}');
  const ownerName  = s.ownerName || '';

  if (channel === 'whatsapp') {
    return (
`Hallo ${mandantVorname} 👋

ich freue mich, dir bestätigen zu können: Unser gemeinsamer Termin steht fest! 🎉

📅 *${weekday}, ${datum}*
⏰ *${uhrzeit} Uhr*
💬 *${terminart}*

${mitarbeiterName ? `Du wirst dabei von *${mitarbeiterName}* begleitet – gemeinsam schauen wir uns an, wie wir deinen 10%igen wirtschaftlichen Vorteil auf dein Nettoeinkommen optimal umsetzen.` : ''}

Direkt nach Bestätigung erhältst du eine Kalender-Einladung (.ics) zum Eintragen in deinen Kalender. 📲

Bei Fragen erreichst du mich jederzeit hier.

Bis dann! 😊
${ownerName ? ownerName : ''}`
    );
  }

  // E-Mail-Variante
  return (
`Hallo ${mandantVorname},

hiermit bestätige ich unseren gemeinsamen Termin:

📅 Datum:    ${weekday}, ${datum}
⏰ Uhrzeit:  ${uhrzeit} Uhr
💬 Art:      ${terminart}
${mitarbeiterName ? `👥 Mit dabei: ${mitarbeiterName}` : ''}

In diesem Gespräch werden wir gemeinsam herausarbeiten, wie du deinen 10%igen wirtschaftlichen Vorteil auf dein Nettoeinkommen konkret realisieren kannst.

Im Anhang dieser E-Mail findest du eine .ics-Kalender-Datei – einfach anklicken und der Termin wird direkt in deinen Kalender eingetragen.

Bei Fragen stehe ich dir jederzeit zur Verfügung.

Mit freundlichen Grüßen
${ownerName ? ownerName : ''}`
  );
}

// ── Tab-Wechsel ──
window.twShowTab = function(tab) {
  ['wa','email'].forEach(t => {
    document.getElementById(`twContent_${t}`).style.display  = t === tab ? 'block' : 'none';
    const btn = document.getElementById(`twTab_${t}`);
    if (!btn) return;
    if (t === tab) {
      btn.style.borderColor  = t === 'wa' ? 'rgba(37,211,102,0.5)'  : 'rgba(59,130,246,0.5)';
      btn.style.background   = t === 'wa' ? 'rgba(37,211,102,0.1)'  : 'rgba(59,130,246,0.1)';
      btn.style.color        = t === 'wa' ? '#25d366' : 'var(--accent)';
      btn.style.fontWeight   = '600';
    } else {
      btn.style.borderColor  = 'var(--border2)';
      btn.style.background   = 'transparent';
      btn.style.color        = 'var(--text2)';
      btn.style.fontWeight   = '400';
    }
  });
};

window.copyTwText = function(tab) {
  const el = document.getElementById(`twText_${tab}`);
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => toast('Text kopiert!'));
};

window.openWhatsApp = function(phone, tab) {
  const el = document.getElementById(`twText_${tab}`);
  const text = el ? el.value : '';
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, '_blank');
};

window.openEmailClient = function(email, tab, mitarbeiterName, datum) {
  const el = document.getElementById(`twText_${tab}`);
  const body = el ? el.value : '';
  const subject = encodeURIComponent(`Terminbestätigung – ${datum}`);
  window.open(`mailto:${email}?subject=${subject}&body=${encodeURIComponent(body)}`, '_blank');
};


// ============================================================
// DASHBOARD: Button "Vorlage senden" bei bestätigten Dreier-Terminen
// ============================================================

/**
 * Ergänzt renderStaffInboxHTML so, dass bestätigte Dreier-Termine
 * einen zusätzlichen "Vorlage" Button erhalten.
 * Einbindung: Nach dem Aufruf von renderStaffInboxHTML das Ergebnis
 * mit diesem Decorator wrappen ODER einfach als Button in die
 * bestätigte Ansicht integrieren (Variante unten).
 */
window.openThreewayTemplateForConfirmed = function(slotId) {
  window.openThreewayTemplate(slotId);
};


// ============================================================
// KONTAKT-DETAIL: Kategorie-Feld ergänzen
// ============================================================

const _origShowContact = window.showContact;

window.showContact = function(id) {
  _origShowContact(id);

  // Nach Rendern: Kategorie-Widget injizieren
  requestAnimationFrame(() => {
    const c = contacts.find(x => x.id === id);
    if (!c) return;

    const labels    = getCategoryLabels();
    const detailCard = document.querySelector('.detail-card h3');
    if (!detailCard) return;

    // Kategorie-Row nach der ersten Detail-Card einfügen
    const detailRows = document.querySelectorAll('.detail-row');
    if (!detailRows.length) return;

    const lastRow = detailRows[detailRows.length - 1];
    if (lastRow.dataset.catInjected) return; // verhindert Doppel-Injektion

    const catRow = document.createElement('div');
    catRow.className = 'detail-row';
    catRow.dataset.catInjected = '1';
    catRow.innerHTML = `
      <span class="detail-key">Kategorie</span>
      <span class="detail-val" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span class="cat-badge-wrap">${categoryBadge(c.contactCategory) || '<span style="color:var(--text3);font-size:13px;">—</span>'}</span>
        ${auth.currentUser?.email === ALLOWED_EMAIL ? `
        <select onchange="setContactCategory('${c.id}',this.value);this.closest('.detail-val').querySelector('.cat-badge-wrap').innerHTML=categoryBadge(this.value)||'<span style=color:var(--text3);font-size:13px;>—</span>'"
          style="font-size:12px;background:var(--bg2);border:1px solid var(--border2);color:var(--text2);
          border-radius:6px;padding:3px 8px;cursor:pointer;">
          <option value="" ${!c.contactCategory?'selected':''}>— zuweisen —</option>
          <option value="mandant"           ${c.contactCategory==='mandant'?'selected':''}>${labels.mandant}</option>
          <option value="privat"            ${c.contactCategory==='privat'?'selected':''}>${labels.privat}</option>
          <option value="mitarbeiter"       ${c.contactCategory==='mitarbeiter'?'selected':''}>${labels.mitarbeiter}</option>
          <option value="mandantMitarbeiter" ${c.contactCategory==='mandantMitarbeiter'?'selected':''}>${labels.mandantMitarbeiter}</option>
        </select>` : '<span style="font-size:11px;color:var(--text3);">(nur Admin)</span>'}
      </span>
    `;
    lastRow.insertAdjacentElement('afterend', catRow);
  });
};


// ============================================================
// HELPER: categoryBadge als window-Funktion exponieren
// (wird in inline-onchange-Attributen gebraucht)
// ============================================================
window.categoryBadge = categoryBadge;


// ============================================================
// KLEINANZEIGEN PAGE – v2 (eingebettet aus kleinanzeigen.js)
// ============================================================
// kaDb nutzt die bereits initialisierte Firebase-Instanz
const kaDb = getFirestore(app);

// ── Social Media Channels ─────────────────────────────────────
const KA_SOCIAL_CHANNELS = ['Instagram','TikTok','LinkedIn','Xing','Facebook','Bumble for Friends'];

const KA_CHANNEL_COLORS = {
  Instagram:            { c:'#e1306c', bg:'rgba(225,48,108,0.1)'  },
  TikTok:               { c:'#69c9d0', bg:'rgba(105,201,208,0.1)' },
  LinkedIn:             { c:'#0a66c2', bg:'rgba(10,102,194,0.1)'  },
  Xing:                 { c:'#026466', bg:'rgba(2,100,102,0.1)'   },
  Facebook:             { c:'#1877f2', bg:'rgba(24,119,242,0.1)'  },
  'Bumble for Friends': { c:'#f5a623', bg:'rgba(245,166,35,0.1)'  },
};

// ── State ─────────────────────────────────────────────────────
let kaActiveTab            = 'aktive';
let kaActiveSubTab         = 'sub-steuerberater';
let kaActiveNestedTab      = 'steuer-privat-pane';
let kaFirebaseLeads        = [];
let kaFirebaseAvailable    = false;
let kaUnsubscribe          = null;
// Social Media Inbox State
let kaSocialMessages       = [];
let kaSocialUnsubscribe    = null;
let kaSocialActiveFilter   = 'alle';
let kaSocialActiveChannels = new Set(KA_SOCIAL_CHANNELS); // Alle Kanäle standardmäßig aktiv (ausgeklappt)
// Multi-Select State
let kaSelectedIds          = new Set();

// ── Vorlagen-State (localStorage-backed) ─────────────────────
const KA_VORLAGEN_DEFAULTS = {
  ka_activeMessage:        'Hallo! Ich habe Ihre Anzeige bezüglich eines Nebenverdienstes gesehen. Da wir aktuell Unterstützung im Raum Ulm suchen, würde ich mich über ein kurzes Telefonat freuen. Wann passt es Ihnen am besten?',
  ka_passiveMessage:       'Hallo! Wir suchen aktuell bundesweit Unterstützung für eine flexible Tätigkeit im Homeoffice/Nebenverdienst. Hätten Sie Zeit für ein kurzes Telefonat?',
  ka_steuerPrivatMessage:  'Hallo! Ich habe Ihre Anfrage bezüglich Unterstützung bei der Steuererklärung gesehen. Gerne helfe ich Ihnen im privaten Bereich weiter. Wann passt ein kurzes Telefonat?',
  ka_steuerFirmaMessage:   'Guten Tag! Bezüglich Ihrer Suche nach strategischer Steuer- und Buchhaltungsberatung unterstütze ich Sie gerne.',
  ka_versicherungMessage:  'Hallo! Gerne prüfe ich Ihre Absicherungen auf Einsparpotenziale. Wann können wir hierzu kurz sprechen?',
  ka_kreditMessage:        'Hallo! Ich habe Ihre Finanzierungsanfrage gesehen. Ich erstelle Ihnen gerne einen unabhängigen Vergleich.',
  ka_finanzberaterMessage: 'Hallo! Gerne unterstütze ich Sie bei Ihrem Vermögensaufbau. Wann hätten Sie Zeit für ein Erstgespräch?',
  ka_sonstigesMessage:     'Hallo! Ich helfe Ihnen gerne beim Thema Vermögensaufbau und staatliche Förderungen.',
};

function kaGetVorlage(id) {
  try {
    const saved = localStorage.getItem('kaVorlage_' + id);
    return saved !== null ? saved : (KA_VORLAGEN_DEFAULTS[id] || '');
  } catch { return KA_VORLAGEN_DEFAULTS[id] || ''; }
}

window.kaSaveVorlage = function(id) {
  const el = document.getElementById(id);
  if (!el) return;
  try {
    localStorage.setItem('kaVorlage_' + id, el.value);
    window.toast?.('Vorlage gespeichert ✓', 'success');
  } catch (e) {
    window.toast?.('Speichern fehlgeschlagen: ' + e.message, 'error');
  }
};

window.kaResetVorlage = function(id) {
  try {
    localStorage.removeItem('kaVorlage_' + id);
    const el = document.getElementById(id);
    if (el) el.value = KA_VORLAGEN_DEFAULTS[id] || '';
    window.toast?.('Vorlage zurückgesetzt ✓', 'success');
  } catch (e) {
    window.toast?.('Fehler: ' + e.message, 'error');
  }
};

// ── Firebase Live-Listener ────────────────────────────────────
function kaInitFirebase() {
  // kaLeads Listener
  try {
    const q = query(collection(kaDb, 'kaLeads'), orderBy('eingelesen', 'desc'));
    kaUnsubscribe = onSnapshot(q, snap => {
      kaFirebaseLeads = [];
      snap.forEach(d => kaFirebaseLeads.push({ id: d.id, ...d.data() }));
      kaFirebaseAvailable = true;
      const contentEl = document.getElementById('content');
      if (contentEl && document.querySelector('.nav-item.active[data-page="kleinanzeigen"]')) {
        renderKleinanzeigen();
      }
    }, err => {
      console.warn('[KA] Firebase Listener Fehler:', err.message);
      kaFirebaseAvailable = false;
    });
  } catch (e) {
    console.warn('[KA] Firebase-Init fehlgeschlagen:', e.message);
    kaFirebaseAvailable = false;
  }

  // socialMessages Listener
  try {
    const sq = query(collection(kaDb, 'socialMessages'), orderBy('eingelesen', 'desc'));
    kaSocialUnsubscribe = onSnapshot(sq, snap => {
      kaSocialMessages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (document.querySelector('.nav-item.active[data-page="kleinanzeigen"]')
          && kaActiveTab === 'socialMedia') {
        window.kaRefreshSocialMedia();
      } else if (document.getElementById('smChatsBody')) {
        window.kaRefreshSocialMedia();
      }
    }, err => console.warn('[KA Social] Listener Fehler:', err.message));
  } catch (e) {
    console.warn('[KA Social] Firebase-Init fehlgeschlagen:', e.message);
  }
}

// ── PLZ → Koordinaten (häufigste PLZ-Gebiete DE, Mittelpunkte) ──
const KA_PLZ_COORDS = {
  '01':[ 51.05, 13.74],'02':[51.50,14.63],'03':[51.76,14.33],'04':[51.34,12.38],
  '06':[51.48,11.97],'07':[50.93,11.59],'08':[50.63,12.49],'09':[50.83,12.92],
  '10':[52.52,13.40],'12':[52.46,13.45],'13':[52.57,13.33],'14':[52.40,13.06],
  '15':[52.13,14.27],'16':[52.84,13.48],'17':[53.75,13.48],'18':[54.09,12.10],
  '19':[53.63,11.41],'20':[53.55,10.00],'21':[53.46,10.21],'22':[53.59,10.07],
  '23':[53.87,10.69],'24':[54.32,10.13],'25':[54.17, 9.08],'26':[53.14, 8.21],
  '27':[53.07, 8.80],'28':[53.08, 8.80],'29':[52.87, 9.99],'30':[52.37, 9.73],
  '31':[52.15, 9.96],'32':[52.02, 8.53],'33':[51.72, 8.75],'34':[51.32, 9.50],
  '35':[50.58, 8.68],'36':[50.55, 9.68],'37':[51.54, 9.93],'38':[52.27,10.52],
  '39':[52.13,11.62],'40':[51.22, 6.78],'41':[51.20, 6.44],'42':[51.27, 7.19],
  '44':[51.51, 7.46],'45':[51.46, 7.01],'46':[51.68, 6.62],'47':[51.44, 6.63],
  '48':[52.28, 7.63],'49':[52.27, 8.05],'50':[50.94, 6.96],'51':[51.03, 7.36],
  '52':[50.77, 6.09],'53':[50.73, 7.10],'54':[49.75, 6.64],'55':[49.99, 8.27],
  '56':[50.36, 7.60],'57':[50.92, 8.02],'58':[51.35, 7.46],'59':[51.51, 7.92],
  '60':[50.11, 8.68],'61':[50.38, 8.74],'63':[50.05, 8.99],'64':[49.87, 8.65],
  '65':[50.08, 8.24],'66':[49.23, 7.00],'67':[49.44, 8.18],'68':[49.49, 8.47],
  '69':[49.40, 8.68],'70':[48.78, 9.18],'71':[48.83, 9.10],'72':[48.49, 8.97],
  '73':[48.79, 9.59],'74':[49.13, 9.21],'75':[48.89, 8.70],'76':[49.00, 8.40],
  '77':[48.47, 7.95],'78':[48.05, 8.53],'79':[47.99, 7.85],'80':[48.14,11.58],
  '81':[48.11,11.61],'82':[47.97,11.33],'83':[47.86,12.10],'84':[48.57,12.15],
  '85':[48.37,11.79],'86':[48.37,10.90],'87':[47.72,10.30],'88':[47.90,10.00],
  '89':[48.40, 9.99],'90':[49.45,11.08],'91':[49.30,10.59],'92':[49.68,12.15],
  '93':[49.02,12.10],'94':[48.57,13.45],'95':[50.00,11.99],'96':[49.90,10.90],
  '97':[49.80, 9.93],'98':[50.71,10.94],'99':[51.00,11.03],
};

const KA_ULM_LAT = 48.3974, KA_ULM_LNG = 9.9934;

function kaPlzDistanceKm(plz) {
  if (!plz) return null;
  const prefix2 = String(plz).substring(0, 2);
  const coords  = KA_PLZ_COORDS[prefix2];
  if (!coords) return null;
  const R   = 6371;
  const dLat = (coords[0] - KA_ULM_LAT) * Math.PI / 180;
  const dLng = (coords[1] - KA_ULM_LNG) * Math.PI / 180;
  const a   = Math.sin(dLat/2)**2 + Math.cos(KA_ULM_LAT*Math.PI/180)*Math.cos(coords[0]*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Homeoffice-Ausschluss-Erkennung ──────────────────────────
const KA_HOMEOFFICE_EXCLUDE = [
  'kein homeoffice','kein home office','keine homeoffice','keine home-office',
  'nur vor ort','ausschließlich vor ort','präsenzpflicht','vollzeit präsenz',
  'nicht remote','kein remote','no remote','not remote',
  'büropflicht','im büro','im office','festanstellung vor ort',
  'keine remote','kein telearbeit',
];
const KA_HOMEOFFICE_REQUIRE = [
  'homeoffice','home office','home-office','remote','von zuhause','von zu hause',
  'mobiles arbeiten','telearbeit','dezentral','flexibel','nebenverdienst',
  'nebenjob','nebenberuf','minijob','selbstständig','freiberuf',
];

function kaWantsHomeoffice(lead) {
  const haystack = ((lead.titel || '') + ' ' + (lead.text || '')).toLowerCase();
  // Ausschluss hat Vorrang
  if (KA_HOMEOFFICE_EXCLUDE.some(kw => haystack.includes(kw))) return false;
  // Muss mindestens ein positives Stichwort haben
  return KA_HOMEOFFICE_REQUIRE.some(kw => haystack.includes(kw));
}

// ── Lead-Filter-Hilfsfunktion ─────────────────────────────────
function kaGetLeads(kategorie, subKat = null, status = null) {
  return kaFirebaseLeads.filter(l => {
    // Distanz-basierte Kategorisierung (überschreibt das gespeicherte kategorie-Feld)
    if (kategorie === 'aktive' || kategorie === 'passive') {
      const dist = kaPlzDistanceKm(l.plz);
      if (kategorie === 'aktive') {
        // Aktiv: ≤ 100 km — wenn PLZ unbekannt, nach gespeichertem Feld fallback
        if (dist !== null && dist > 100) return false;
        if (dist === null && l.kategorie !== 'aktive') return false;
      } else {
        // Passiv: > 100 km UND Homeoffice-bereit
        if (dist !== null && dist <= 100) return false;
        if (dist === null && l.kategorie !== 'passive') return false;
        if (!kaWantsHomeoffice(l)) return false;
      }
    } else {
      if (l.kategorie !== kategorie) return false;
    }
    if (subKat && l.subKat !== subKat) return false;
    if (status && l.status !== status) return false;
    return true;
  });
}

// ── UI-Hilfsfunktionen ────────────────────────────────────────
function kaCounter(n, color = 'var(--text2)') {
  return `<span style="background:var(--bg3);border:1px solid var(--border);color:${color};border-radius:20px;padding:2px 10px;font-size:12px;font-weight:600;">${n}</span>`;
}

function kaTabBtn(id, label, active) {
  return `<button onclick="kaOpenTab('${id}')"
    style="display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:8px;
      font-size:14px;font-weight:500;cursor:pointer;
      border:1px solid ${active ? 'rgba(59,130,246,0.5)' : 'var(--border2)'};
      background:${active ? 'rgba(59,130,246,0.12)' : 'var(--bg3)'};
      color:${active ? 'var(--accent)' : 'var(--text2)'};
      font-family:inherit;transition:all .15s;"
    onmouseover="if(!${active})this.style.background='var(--surface2)';if(!${active})this.style.color='var(--text)'"
    onmouseout="if(!${active})this.style.background='var(--bg3)';if(!${active})this.style.color='var(--text2)'"
  >${label}</button>`;
}

function kaSubTabBtn(id, label, active) {
  return `<button onclick="kaOpenSubTab('${id}')"
    style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;
      font-size:13px;font-weight:500;cursor:pointer;
      border:1px solid ${active ? 'rgba(167,139,250,0.4)' : 'var(--border)'};
      background:${active ? 'rgba(167,139,250,0.1)' : 'transparent'};
      color:${active ? 'var(--purple)' : 'var(--text3)'};
      font-family:inherit;transition:all .15s;"
  >${label}</button>`;
}

function kaNestedTabBtn(id, label, active) {
  return `<button onclick="kaOpenNestedTab('${id}')"
    style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:6px;
      font-size:12px;font-weight:500;cursor:pointer;
      border:1px solid ${active ? 'rgba(59,130,246,0.35)' : 'var(--border)'};
      background:${active ? 'rgba(59,130,246,0.1)' : 'var(--bg3)'};
      color:${active ? 'var(--accent)' : 'var(--text3)'};
      font-family:inherit;transition:all .15s;"
  >${label}</button>`;
}

function kaStatusPill(status) {
  const map = {
    neu:              { c:'var(--accent)', bg:'rgba(59,130,246,0.1)',  label:'Neu' },
    angeschrieben:    { c:'var(--amber)',  bg:'rgba(245,158,11,0.1)',  label:'Angeschrieben' },
    kontakt_angelegt: { c:'var(--green)', bg:'rgba(34,197,94,0.1)',   label:'Kontakt angelegt' }
  };
  const s = map[status] || map['neu'];
  return `<span style="font-size:11px;color:${s.c};background:${s.bg};border:1px solid ${s.c}33;padding:2px 8px;border-radius:20px;">${s.label}</span>`;
}

function kaPanel(title, content) {
  return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px;">
    <div style="font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:14px;">${title}</div>
    ${content}
  </div>`;
}

function kaTextarea(id, _defaultIgnored) {
  const saved = kaGetVorlage(id);
  return `
    <textarea id="${id}" rows="3"
      style="width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);
        border-radius:8px;padding:10px 12px;font-size:13px;font-family:inherit;
        outline:none;resize:vertical;line-height:1.5;"
      onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border2)'"
    >${saved}</textarea>
    <div style="display:flex;gap:6px;margin-top:8px;">
      <button onclick="kaSaveVorlage('${id}')"
        style="flex:1;padding:6px 10px;border-radius:7px;border:none;
          background:var(--accent);color:#fff;font-size:11px;font-weight:600;
          cursor:pointer;font-family:inherit;">
        💾 Vorlage speichern
      </button>
      <button onclick="kaResetVorlage('${id}')"
        style="padding:6px 10px;border-radius:7px;border:1px solid var(--border2);
          background:transparent;color:var(--text3);font-size:11px;
          cursor:pointer;font-family:inherit;" title="Auf Standard zurücksetzen">
        ↺ Reset
      </button>
    </div>`;
}

function kaSectionTitle(label, count, color) {
  return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
    <h3 style="font-size:15px;font-weight:600;color:var(--text);">${label}</h3>
    ${kaCounter(count, color)}
  </div>`;
}

function kaStatusBanner() {
  if (kaFirebaseAvailable) {
    const neu = kaFirebaseLeads.filter(l => l.status === 'neu').length;
    return `<div style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);
      border-radius:8px;padding:8px 14px;margin-bottom:16px;font-size:11px;color:var(--green);
      display:flex;align-items:center;gap:8px;">
      <i class="ti ti-wifi"></i>
      Live-Sync aktiv · ${kaFirebaseLeads.length} Leads gesamt · ${neu} neu
    </div>`;
  }
  return `<div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);
    border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:var(--amber);
    display:flex;align-items:center;gap:8px;">
    <i class="ti ti-wifi-off"></i>
    Keine Firebase-Verbindung — Chrome Extension installiert und aktiv?
  </div>`;
}

// ── Lead-Card (Firebase-Daten) ────────────────────────────────
function kaLeadCard(lead, msgTextareaId) {
  const ort    = lead.ort   || 'Unbekannt';
  const titel  = lead.titel || '(Kein Titel)';
  const text   = lead.text  || '';
  const link   = lead.link  || '#';
  const since  = lead.eingelesen?.toDate
    ? lead.eingelesen.toDate().toLocaleDateString('de-DE')
    : '';
  const ageMeta = lead.age ? `${lead.age} J. · ` : '';
  const isSelected = kaSelectedIds.has(lead.id);

  const contactBtn = lead.status !== 'kontakt_angelegt'
    ? `<button onclick="kaOpenContactFromLead('${lead.id}')"
        style="display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:8px;
          border:1px solid rgba(34,197,94,0.35);background:rgba(34,197,94,0.08);
          color:var(--green);font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;"
        onmouseover="this.style.background='rgba(34,197,94,0.18)'" onmouseout="this.style.background='rgba(34,197,94,0.08)'">
        <i class="ti ti-user-plus"></i> Als Kontakt anlegen
      </button>`
    : `<span style="font-size:12px;color:var(--green);"><i class="ti ti-check"></i> Kontakt angelegt</span>`;

  const angeschriebenBtn = lead.status === 'neu'
    ? `<button onclick="kaMarkAngeschrieben('${lead.id}')"
        style="display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:8px;
          border:1px solid rgba(245,158,11,0.3);background:rgba(245,158,11,0.08);
          color:var(--amber);font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;">
        <i class="ti ti-mail"></i> Angeschrieben
      </button>` : '';

  return `<div id="ka-card-${lead.id}" style="background:var(--surface);border:1px solid ${isSelected ? 'rgba(239,68,68,0.5)' : 'var(--border)'};border-radius:var(--radius-lg);
    padding:14px 16px;margin-bottom:10px;transition:border-color .15s;${isSelected ? 'background:rgba(239,68,68,0.04);' : ''}"
    onmouseover="if(!${isSelected})this.style.borderColor='var(--border2)'" onmouseout="if(!${isSelected})this.style.borderColor='${isSelected ? 'rgba(239,68,68,0.5)' : 'var(--border)'}'">
    <div style="display:flex;align-items:flex-start;gap:12px;">
      <div style="flex-shrink:0;padding-top:2px;">
        <input type="checkbox" ${isSelected ? 'checked' : ''}
          onchange="kaToggleSelect('${lead.id}', this.checked)"
          style="width:16px;height:16px;cursor:pointer;accent-color:#ef4444;">
      </div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
          <a href="${link}" target="_blank" rel="noopener"
            style="font-weight:600;font-size:14px;color:var(--text);text-decoration:none;"
            onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text)'">
            ${titel} <i class="ti ti-external-link" style="font-size:11px;opacity:.6;"></i>
          </a>
          ${kaStatusPill(lead.status)}
          ${lead.keinAlter ? '<span style="font-size:11px;color:var(--amber);background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);padding:2px 7px;border-radius:20px;">⚠ Kein Alter</span>' : ''}
        </div>
        <div style="font-size:12px;color:var(--accent);margin-bottom:6px;">${ageMeta}${ort}${since ? ' · ' + since : ''}</div>
        <div style="font-size:13px;color:var(--text2);line-height:1.5;margin-bottom:8px;">"${text.substring(0,200)}${text.length>200?'…':''}"</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          ${contactBtn}
          ${angeschriebenBtn}
          <button onclick="kaDeleteLead('${lead.id}')"
            style="display:inline-flex;align-items:center;gap:4px;padding:6px 10px;border-radius:8px;
              border:1px solid rgba(239,68,68,0.2);background:transparent;
              color:#f87171;font-size:12px;cursor:pointer;font-family:inherit;">
            <i class="ti ti-trash"></i>
          </button>
        </div>
      </div>
      <button onclick="window.open('${link}','_blank')"
        style="flex-shrink:0;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;
          border-radius:8px;border:1px solid var(--border2);background:var(--bg3);
          color:var(--text2);font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;
          transition:all .15s;white-space:nowrap;"
        onmouseover="this.style.background='var(--surface2)';this.style.color='var(--text)'"
        onmouseout="this.style.background='var(--bg3)';this.style.color='var(--text2)'">
        <i class="ti ti-external-link"></i> Öffnen
      </button>
    </div>
  </div>`;
}

// ── Multi-Select Toolbar ──────────────────────────────────────
function kaMultiSelectToolbar(visibleLeads) {
  if (visibleLeads.length === 0) return '';
  const allSelected = visibleLeads.every(l => kaSelectedIds.has(l.id));
  const idList = visibleLeads.map(l => l.id).join(',');
  const selCount = kaSelectedIds.size;
  return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;
      padding:10px 14px;background:var(--surface);border:1px solid var(--border);
      border-radius:10px;flex-wrap:wrap;">
      <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px;color:var(--text2);user-select:none;">
        <input id="ka-select-all-cb" type="checkbox" ${allSelected ? 'checked' : ''}
          data-ids="${idList}"
          onchange="kaSelectAll(this.checked, this.dataset.ids.split(','))"
          style="width:15px;height:15px;accent-color:#ef4444;cursor:pointer;">
        Alle markieren
      </label>
      <span id="ka-select-counter" style="font-size:12px;color:var(--text3);">${selCount > 0 ? selCount + ' ausgewählt' : ''}</span>
      <div style="flex:1;"></div>
      <button id="ka-delete-selected-btn" onclick="kaDeleteSelected()"
        style="display:${selCount > 0 ? 'inline-flex' : 'none'};align-items:center;gap:6px;padding:7px 14px;border-radius:8px;
          border:1px solid rgba(239,68,68,0.4);background:rgba(239,68,68,0.08);
          color:#f87171;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;"
        onmouseover="this.style.background='rgba(239,68,68,0.18)'"
        onmouseout="this.style.background='rgba(239,68,68,0.08)'">
        <i class="ti ti-trash"></i> <span>${selCount} löschen</span>
      </button>
    </div>`;
}

window.kaToggleSelect = function(id, checked) {
  if (checked) kaSelectedIds.add(id); else kaSelectedIds.delete(id);
  // Karte visuell aktualisieren ohne komplettes Re-Render
  const card = document.getElementById('ka-card-' + id);
  if (card) {
    card.style.borderColor = checked ? 'rgba(239,68,68,0.5)' : 'var(--border)';
    card.style.background  = checked ? 'rgba(239,68,68,0.04)' : 'var(--surface)';
  }
  // Zähler in Toolbar aktualisieren
  const counter = document.getElementById('ka-select-counter');
  if (counter) counter.textContent = kaSelectedIds.size > 0 ? `${kaSelectedIds.size} ausgewählt` : '';
  const delBtn = document.getElementById('ka-delete-selected-btn');
  if (delBtn) {
    delBtn.style.display = kaSelectedIds.size > 0 ? 'inline-flex' : 'none';
    delBtn.querySelector('span').textContent = `${kaSelectedIds.size} löschen`;
  }
  // "Alle markieren" Checkbox synchronisieren
  const allCheckbox = document.getElementById('ka-select-all-cb');
  if (allCheckbox) {
    const allIds = allCheckbox.dataset.ids?.split(',') || [];
    allCheckbox.checked = allIds.length > 0 && allIds.every(i => kaSelectedIds.has(i));
  }
};

window.kaSelectAll = function(checked, ids) {
  ids.forEach(id => { if (checked) kaSelectedIds.add(id); else kaSelectedIds.delete(id); });
  renderKleinanzeigen();
};

window.kaDeleteSelected = async function() {
  if (kaSelectedIds.size === 0) return;
  if (!confirm(`${kaSelectedIds.size} Leads wirklich löschen?`)) return;
  const ids = [...kaSelectedIds];
  kaSelectedIds.clear();
  let errors = 0;
  for (const id of ids) {
    try { await deleteDoc(doc(kaDb, 'kaLeads', id)); }
    catch { errors++; }
  }
  if (errors > 0) window.toast?.(`${errors} Fehler beim Löschen.`, 'error');
  else window.toast?.(`${ids.length} Leads gelöscht ✓`, 'success');
};

// ── Tab-Inhalte ────────────────────────────────────────────────
function kaRenderAktive() {
  const neu = kaGetLeads('aktive').filter(l => l.status === 'neu');
  const all = kaGetLeads('aktive');
  return `
    ${kaStatusBanner()}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      ${kaPanel('Aktive Suchkriterien (Lokal)', `
        <div style="display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
            <span style="color:var(--text2);">Alter</span><span style="color:var(--text);">18 – 49 Jahre</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
            <span style="color:var(--text2);">Umkreis</span><span style="color:var(--text);">≤ 100 km um Ulm</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;">
            <span style="color:var(--text2);">Gesamt</span>
            <span style="color:var(--accent);font-weight:600;">${all.length} Leads · ${neu.length} neu</span>
          </div>
        </div>`)}
      ${kaPanel('Standard-Anschreiben', kaTextarea('ka_activeMessage', 'Hallo! Ich habe Ihre Anzeige bezüglich eines Nebenverdienstes gesehen. Da wir aktuell Unterstützung im Raum Ulm suchen, würde ich mich über ein kurzes Telefonat freuen. Wann passt es Ihnen am besten?'))}
    </div>
    ${kaSectionTitle('Gefilterte Profile im Umkreis:', neu.length, 'var(--accent)')}
    ${neu.length > 0 ? kaMultiSelectToolbar(neu) + neu.map(l => kaLeadCard(l, 'ka_activeMessage')).join('') : '<div class="empty-state"><i class="ti ti-users"></i><p>Keine neuen Aktiv-Leads</p></div>'}
  `;
}

function kaRenderPassive() {
  const neu = kaGetLeads('passive').filter(l => l.status === 'neu');
  const all = kaGetLeads('passive');
  return `
    ${kaStatusBanner()}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      ${kaPanel('Passive Suchkriterien (Überregional)', `
        <div style="display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
            <span style="color:var(--text2);">Umkreis</span><span style="color:var(--text);">Deutschlandweit</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;">
            <span style="color:var(--text2);">Gesamt</span>
            <span style="color:var(--accent);font-weight:600;">${all.length} Leads · ${neu.length} neu</span>
          </div>
        </div>`)}
      ${kaPanel('Anschreiben (Passiv)', kaTextarea('ka_passiveMessage', 'Hallo! Wir suchen aktuell bundesweit Unterstützung für eine flexible Tätigkeit im Homeoffice/Nebenverdienst. Hätten Sie Zeit für ein kurzes Telefonat?'))}
    </div>
    ${kaSectionTitle('Gefilterte Profile (Restliches DE):', neu.length, 'var(--accent)')}
    ${neu.length > 0 ? kaMultiSelectToolbar(neu) + neu.map(l => kaLeadCard(l, 'ka_passiveMessage')).join('') : '<div class="empty-state"><i class="ti ti-world"></i><p>Keine neuen Passiv-Leads</p></div>'}
  `;
}

function kaRenderMandanten() {
  const subTabs = [
    { id:'sub-steuerberater', label:'<i class="ti ti-file-invoice"></i> Steuerberater' },
    { id:'sub-versicherung',  label:'<i class="ti ti-shield"></i> Versicherung' },
    { id:'sub-kredit',        label:'<i class="ti ti-building-bank"></i> Kredit' },
    { id:'sub-finanzberater', label:'<i class="ti ti-chart-line"></i> Finanzberater' },
    { id:'sub-sonstiges',     label:'<i class="ti ti-dots"></i> Sonstiges' },
  ];

  const neuOf = subKat => kaGetLeads('mandanten', subKat).filter(l => l.status === 'neu');

  const subContents = {
    'sub-steuerberater': () => {
      const privat = neuOf('steuerberater').filter(l => !l.isFirm);
      const firma  = neuOf('steuerberater').filter(l => l.isFirm);
      const nested = [
        { id:'steuer-privat-pane', label:'Privatpersonen' },
        { id:'steuer-firma-pane',  label:'Unternehmen / Gewerbe' },
      ];
      const nc = {
        'steuer-privat-pane': `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
            ${kaPanel('Filter-Modus: Steuerberater (Privat)', '<p style="font-size:13px;color:var(--text2);">Zeigt Anfragen von Privatpersonen.</p>')}
            ${kaPanel('Anschreiben', kaTextarea('ka_steuerPrivatMessage', 'Hallo! Ich habe Ihre Anfrage bezüglich Unterstützung bei der Steuererklärung gesehen. Gerne helfe ich Ihnen im privaten Bereich weiter. Wann passt ein kurzes Telefonat?'))}
          </div>
          ${kaSectionTitle('Privatpersonen Anfragen:', privat.length, 'var(--purple)')}
          ${privat.length > 0 ? kaMultiSelectToolbar(privat) + privat.map(l => kaLeadCard(l, 'ka_steuerPrivatMessage')).join('') : '<div class="empty-state"><i class="ti ti-file-invoice"></i><p>Keine Treffer</p></div>'}`,
        'steuer-firma-pane': `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
            ${kaPanel('Filter-Modus: Steuerberater (Gewerblich)', '<p style="font-size:13px;color:var(--text2);">Filtert Firmen/Gewerbe.</p>')}
            ${kaPanel('Anschreiben', kaTextarea('ka_steuerFirmaMessage', 'Guten Tag! Bezüglich Ihrer Suche nach strategischer Steuer- und Buchhaltungsberatung unterstütze ich Sie gerne.'))}
          </div>
          ${kaSectionTitle('Unternehmen Anfragen:', firma.length, 'var(--purple)')}
          ${firma.length > 0 ? kaMultiSelectToolbar(firma) + firma.map(l => kaLeadCard(l, 'ka_steuerFirmaMessage')).join('') : '<div class="empty-state"><i class="ti ti-building"></i><p>Keine Treffer</p></div>'}`
      };
      return `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;">
          ${nested.map(t => kaNestedTabBtn(t.id, t.label, kaActiveNestedTab === t.id)).join('')}
        </div>
        ${nc[kaActiveNestedTab] || nc['steuer-privat-pane']}`;
    },
    'sub-versicherung': () => {
      const list = neuOf('versicherung');
      return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
          ${kaPanel('Filter-Modus: Versicherung', '')}
          ${kaPanel('Anschreiben', kaTextarea('ka_versicherungMessage', 'Hallo! Gerne prüfe ich Ihre Absicherungen auf Einsparpotenziale. Wann können wir hierzu kurz sprechen?'))}
        </div>
        ${kaSectionTitle('Anfragen Versicherungen:', list.length, 'var(--amber)')}
        ${list.length > 0 ? kaMultiSelectToolbar(list) + list.map(l => kaLeadCard(l, 'ka_versicherungMessage')).join('') : '<div class="empty-state"><i class="ti ti-shield"></i><p>Keine Treffer</p></div>'}`;
    },
    'sub-kredit': () => {
      const list = neuOf('kredit');
      return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
          ${kaPanel('Filter-Modus: Kredit & Finanzierung', '')}
          ${kaPanel('Anschreiben', kaTextarea('ka_kreditMessage', 'Hallo! Ich habe Ihre Finanzierungsanfrage gesehen. Ich erstelle Ihnen gerne einen unabhängigen Vergleich.'))}
        </div>
        ${kaSectionTitle('Anfragen Finanzierungen:', list.length, 'var(--green)')}
        ${list.length > 0 ? kaMultiSelectToolbar(list) + list.map(l => kaLeadCard(l, 'ka_kreditMessage')).join('') : '<div class="empty-state"><i class="ti ti-building-bank"></i><p>Keine Treffer</p></div>'}`;
    },
    'sub-finanzberater': () => {
      const list = neuOf('finanzberater');
      return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
          ${kaPanel('Filter-Modus: Finanzberatung', '')}
          ${kaPanel('Anschreiben', kaTextarea('ka_finanzberaterMessage', 'Hallo! Gerne unterstütze ich Sie bei Ihrem Vermögensaufbau. Wann hätten Sie Zeit für ein Erstgespräch?'))}
        </div>
        ${kaSectionTitle('Kundenanfragen Finanzberatung:', list.length, 'var(--accent)')}
        ${list.length > 0 ? kaMultiSelectToolbar(list) + list.map(l => kaLeadCard(l, 'ka_finanzberaterMessage')).join('') : '<div class="empty-state"><i class="ti ti-chart-line"></i><p>Keine Treffer</p></div>'}`;
    },
    'sub-sonstiges': () => {
      const list = neuOf('sonstiges');
      return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
          ${kaPanel('Allfinanz / Sonstiges', '')}
          ${kaPanel('Anschreiben', kaTextarea('ka_sonstigesMessage', 'Hallo! Ich helfe Ihnen gerne beim Thema Vermögensaufbau und staatliche Förderungen.'))}
        </div>
        ${kaSectionTitle('Allfinanz Anfragen:', list.length, 'var(--text2)')}
        ${list.length > 0 ? kaMultiSelectToolbar(list) + list.map(l => kaLeadCard(l, 'ka_sonstigesMessage')).join('') : '<div class="empty-state"><i class="ti ti-dots"></i><p>Keine Treffer</p></div>'}`;
    }
  };

  const renderFn = subContents[kaActiveSubTab] || subContents['sub-steuerberater'];
  return `
    ${kaStatusBanner()}
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid var(--border);">
      ${subTabs.map(t => kaSubTabBtn(t.id, t.label, kaActiveSubTab === t.id)).join('')}
    </div>
    ${renderFn()}
  `;
}

function kaRenderAngeschrieben() {
  const list = kaFirebaseLeads.filter(l => l.status === 'angeschrieben');
  return `
    ${kaStatusBanner()}
    <div style="margin-bottom:16px;">
      ${kaSectionTitle('Bereits angeschrieben:', list.length, 'var(--amber)')}
      <p style="font-size:12px;color:var(--text3);margin-bottom:16px;">Leads die kontaktiert wurden. Nach 7 Tagen ohne Reaktion werden sie automatisch gelöscht.</p>
    </div>
    ${list.length > 0 ? kaMultiSelectToolbar(list) + list.map(l => kaLeadCard(l, 'ka_angeschriebenMsg')).join('') : '<div class="empty-state"><i class="ti ti-mail-off"></i><p>Noch niemanden angeschrieben</p></div>'}
    <textarea id="ka_angeschriebenMsg" style="display:none;"></textarea>
  `;
}

function kaRenderSocialMedia() {
  const statusMap = {
    neu:              { c:'var(--accent, var(--accent-color))', bg:'rgba(59,130,246,0.1)',  label:'Neu' },
    kontakt_angelegt: { c:'var(--green, var(--success-color))',  bg:'rgba(34,197,94,0.1)',   label:'Kontakt angelegt' },
  };
  const kanalIcon = {
    Instagram:            'ti-brand-instagram',
    TikTok:               'ti-brand-tiktok',
    LinkedIn:             'ti-brand-linkedin',
    Xing:                 'ti-brand-xing',
    Facebook:             'ti-brand-facebook',
    'Bumble for Friends': 'ti-heart',
  };

  const kanalBlocks = KA_SOCIAL_CHANNELS.map(k => {
    const col      = KA_CHANNEL_COLORS[k] || { c:'var(--accent, var(--accent-color))', bg:'rgba(59,130,246,0.1)' };
    const icon     = kanalIcon[k] || 'ti-brand-instagram';
    const checked  = kaSocialActiveChannels.has(k);
    const msgs     = kaSocialMessages.filter(m => (m.kanal || '').toLowerCase() === k.toLowerCase());
    const neuCount = msgs.filter(m => m.status === 'neu').length;

    const msgCards = !checked ? '' : msgs.length === 0
      ? `<div style="padding:4px 16px 14px 50px;font-size:13px;color:var(--text3, var(--text-muted));">Noch keine Nachrichten für ${k}</div>`
      : msgs.map(msg => {
          const st   = statusMap[msg.status] || statusMap['neu'];
          const date = msg.eingelesen?.toDate
            ? msg.eingelesen.toDate().toLocaleDateString('de-DE')
            : (msg.eingelesen ? new Date(msg.eingelesen).toLocaleDateString('de-DE') : '');
          const contactBtn = msg.status !== 'kontakt_angelegt'
            ? `<button onclick="kaSocialAddContact('${msg.id}')"
                style="display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:8px;
                  border:1px solid rgba(34,197,94,0.35);background:rgba(34,197,94,0.08);
                  color:var(--green, var(--success-color));font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;"
                onmouseover="this.style.background='rgba(34,197,94,0.18)'" onmouseout="this.style.background='rgba(34,197,94,0.08)'">
                <i class="ti ti-user-plus"></i> Als Kontakt anlegen
              </button>`
            : `<span style="font-size:12px;color:var(--green, var(--success-color));"><i class="ti ti-check"></i> Kontakt angelegt</span>`;
          // Display-Name bestimmen
          const displayName = (msg.contactName && !msg.contactName.startsWith('http'))
            ? msg.contactName
            : (msg.absender && !msg.absender.startsWith('http') ? msg.absender : '(Unbekannt)');

          // Texte die NICHT als Nachricht angezeigt werden sollen
          const skipMsgTexts = new Set([
            displayName, msg.contactName, msg.absender,
            'Instagram', 'TikTok', 'WhatsApp', 'LinkedIn', 'Xing', 'Facebook',
            displayName + ' · Instagram', displayName + ' · TikTok',
            msg.contactName + ' · Instagram', msg.absender + ' · Instagram',
            'Profil ansehen', 'Profil anzeigen',
          ].filter(Boolean).map(t => t.trim()));
          const dateRxMsg = /^\d{1,2}\.\d{2}\.\d{4}/;
          const timeRxMsg = /^(vor\s+\d+|heute|gestern|\d+\s*(min|std|tag|woch|monat|jahr|sec))/i;

          // Gültige Nachrichten filtern
          const cleanMsgs = (Array.isArray(msg.messages) ? msg.messages : [])
            .filter(m => {
              const t = (m.text || '').trim();
              if (!t || t.length < 1) return false;
              if (skipMsgTexts.has(t)) return false;
              if (dateRxMsg.test(t)) return false;
              if (timeRxMsg.test(t)) return false;
              return true;
            })
            .sort((a, b) => {
              // Nach top sortieren falls vorhanden (DOM-Position: oben=alt, unten=neu)
              if (a.top != null && b.top != null) return a.top - b.top;
              return 0; // sonst Reihenfolge beibehalten
            })
            .map(({ top, ...m }) => m);

          // Chatverlauf als Bubbles
          const verlauf = cleanMsgs.length > 0
            ? cleanMsgs.map(m => {
                const isMe = m.sender === 'ich';
                return `<div style="display:flex;flex-direction:column;align-items:${isMe ? 'flex-end' : 'flex-start'};margin-bottom:6px;">
                  <div style="max-width:75%;padding:8px 12px;border-radius:${isMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px'};
                    background:${isMe ? col.c : 'var(--bg2,var(--card-bg))'};
                    color:${isMe ? '#fff' : 'var(--text,var(--text-color))'};
                    font-size:13px;line-height:1.5;word-break:break-word;">
                    ${m.text}
                  </div>
                  <span style="font-size:10px;color:var(--text3,var(--text-muted));margin-top:2px;padding:0 2px;">
                    ${isMe ? 'Du' : displayName}
                  </span>
                </div>`;
              }).join('')
            : `<div style="font-size:12px;color:var(--text3,var(--text-muted));text-align:center;padding:8px 0;">
                Öffne den Chat auf ${k} um Nachrichten zu laden
              </div>`;

          const verlaufId = 'verlauf_' + msg.id;

          return `
            <div style="margin:0 16px 8px 50px;background:var(--bg3, var(--card-bg));border:1px solid var(--border, var(--border-color));
              border-radius:10px;padding:12px 14px;transition:border-color .15s;"
              onmouseover="this.style.borderColor='var(--border2, var(--accent-color))'" onmouseout="this.style.borderColor='var(--border, var(--border-color))'">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
                <span style="font-weight:600;font-size:14px;color:var(--text, var(--text-color));">${displayName}</span>
                <span style="font-size:11px;color:${st.c};background:${st.bg};border:1px solid ${st.c}33;padding:2px 8px;border-radius:20px;">${st.label}</span>
                ${date ? `<span style="font-size:11px;color:var(--text3, var(--text-muted));">${date}</span>` : ''}
                ${msg.profilLink ? `<a href="${msg.profilLink}" target="_blank" style="font-size:11px;color:var(--text3,var(--text-muted));text-decoration:none;margin-left:auto;">🔗 Profil</a>` : ''}
              </div>
              <div id="${verlaufId}" style="max-height:280px;overflow-y:auto;padding:10px;border-radius:10px;
                background:var(--surface,var(--card-bg));margin-bottom:10px;
                border:1px solid var(--border,var(--border-color));">
                ${verlauf}
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                ${contactBtn}
                <button onclick="kaSocialDeleteMessage('${msg.id}')"
                  style="display:inline-flex;align-items:center;gap:4px;padding:6px 10px;border-radius:8px;
                    border:1px solid rgba(239,68,68,0.2);background:transparent;
                    color:#f87171;font-size:12px;cursor:pointer;font-family:inherit;">
                  <i class="ti ti-trash"></i>
                </button>
              </div>
            </div>`;
        }).join('');

    return `
      <div style="background:var(--surface, var(--card-bg));border:1px solid ${checked ? col.c + '66' : 'var(--border, var(--border-color))'};
        border-radius:12px;margin-bottom:10px;overflow:hidden;transition:border-color .2s;">
        <div style="display:flex;align-items:center;gap:14px;padding:14px 16px;">
          <i class="ti ${icon}" style="font-size:20px;color:${col.c};flex-shrink:0;"></i>
          <span style="font-size:15px;font-weight:600;color:var(--text, var(--text-color));flex:1;">${k}</span>
          ${neuCount > 0 ? `<span style="background:${col.bg};color:${col.c};border:1px solid ${col.c}44;border-radius:20px;padding:2px 9px;font-size:12px;font-weight:700;">${neuCount} neu</span>` : ''}
          ${msgs.length > 0 && neuCount === 0 ? `<span style="background:var(--bg3, var(--card-bg));color:var(--text3, var(--text-muted));border:1px solid var(--border, var(--border-color));border-radius:20px;padding:2px 9px;font-size:12px;">${msgs.length}</span>` : ''}
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-left:8px;" title="Chats anzeigen/ausblenden">
            <input type="checkbox" ${checked ? 'checked' : ''} onchange="kaSocialToggleChannel('${k}')"
              style="width:16px;height:16px;accent-color:${col.c};cursor:pointer;">
            <span style="font-size:12px;color:var(--text3, var(--text-muted));">Anzeigen</span>
          </label>
        </div>
        ${msgCards}
        ${checked && msgs.length > 0 ? '<div style="height:6px;"></div>' : ''}
      </div>`;
  }).join('');

  return `<div style="display:flex;flex-direction:column;gap:12px;">${kanalBlocks}</div>`;
}

// ── Haupt-Render ───────────────────────────────────────────────
// ── KA-Chats Tab ──────────────────────────────────────────────
const KA_CHAT_KEY = 'ka_kleinanzeigen_chats';

function kaLoadKaChats() {
  try { return JSON.parse(localStorage.getItem(KA_CHAT_KEY) || '[]'); } catch { return []; }
}

// Normalisiert eine Anzeigen-URL für den Vergleich (ohne Query/Hash/Trailing-Slash)
function kaNormLink(u) {
  return (u || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase();
}

// Findet den zum Chat passenden Lead (gleiche Anzeige, anhand des Links)
function kaFindLeadForChat(chat) {
  if (!chat || !chat.adLink) return null;
  const target = kaNormLink(chat.adLink);
  if (!target) return null;
  return kaFirebaseLeads.find(l => l.link && kaNormLink(l.link) === target) || null;
}

// Lesbares Label für die Lead-Kategorie
function kaKategorieLabel(lead) {
  if (!lead) return '';
  if (lead.kategorie === 'aktive')  return 'Aktiver Mitarbeiter';
  if (lead.kategorie === 'passive') return 'Passiver Mitarbeiter';
  if (lead.kategorie === 'mandanten') return 'Mandant' + (lead.subKat ? ' (' + lead.subKat + ')' : '');
  return lead.kategorie || '';
}

function kaRenderKaChats() {
  const chats = kaLoadKaChats();

  function timeAgo(ts) {
    if (!ts) return '–';
    const d = Date.now() - ts;
    if (d < 60000)    return 'gerade eben';
    if (d < 3600000)  return Math.floor(d/60000) + ' Min.';
    if (d < 86400000) return Math.floor(d/3600000) + ' Std.';
    if (d < 604800000) return Math.floor(d/86400000) + ' Tage';
    return new Date(ts).toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'2-digit'});
  }

  function responseTime(chat) {
    if (!chat.firstContactAt || !chat.firstReplyAt) return null;
    return chat.firstReplyAt - chat.firstContactAt;
  }

  function responseLabel(chat) {
    const msgs = chat.messages || [];
    const hasReply = msgs.some(m => m.sender !== 'ich');
    if (!hasReply) {
      const waited = Date.now() - (chat.firstContactAt || chat.savedAt || Date.now());
      const days = Math.floor(waited / 86400000);
      return `<span style="color:#f87171;font-size:12px;font-weight:600;">✗ Keine Antwort${days > 0 ? ' · ' + days + 'd offen' : ''}</span>`;
    }
    const rt = responseTime(chat);
    const rtStr = rt !== null ? (rt < 3600000 ? Math.floor(rt/60000)+'min' : rt < 86400000 ? Math.floor(rt/3600000)+'h' : Math.floor(rt/86400000)+'d') : '';
    return `<span style="color:#4ade80;font-size:12px;font-weight:600;">✓ Hat geantwortet${rtStr ? ' · ' + rtStr : ''}</span>`;
  }

  if (!chats.length) {
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;text-align:center;gap:12px;">
      <i class="ti ti-message-off" style="font-size:40px;color:var(--text3);"></i>
      <p style="color:var(--text2);font-size:14px;max-width:340px;line-height:1.6;">
        Noch keine KA-Chats gespeichert.<br>
        Öffne einen Chat auf <strong>kleinanzeigen.de</strong> – die Extension erkennt ihn automatisch und legt ihn hier ab.<br><br>
        <span style="font-size:12px;color:var(--text3);">Pro Person wird nur ein Chat gespeichert (kein Duplikat).</span>
      </p>
    </div>`;
  }

  // Statistiken oben
  const total     = chats.length;
  const replied   = chats.filter(c => (c.messages||[]).some(m => m.sender !== 'ich')).length;
  const noReply   = total - replied;
  const rate      = total > 0 ? Math.round(replied/total*100) : 0;

  const statsBar = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px;">
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:var(--text);">${total}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px;">Gesamt</div>
      </div>
      <div style="background:rgba(74,222,128,0.07);border:1px solid rgba(74,222,128,0.2);border-radius:10px;padding:12px 14px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:#4ade80;">${replied}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px;">Geantwortet</div>
      </div>
      <div style="background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.2);border-radius:10px;padding:12px 14px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:#f87171;">${noReply}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px;">Keine Antwort · <strong>${rate}%</strong> Rate</div>
      </div>
    </div>`;

  const cards = chats.map((chat, idx) => {
    const name = (chat.contactName || chat.url || 'Unbekannt').replace(/</g,'&lt;');
    const linkedLead = kaFindLeadForChat(chat);
    const leadNameDiffers = linkedLead && linkedLead.name
      && linkedLead.name.trim().toLowerCase() !== (chat.contactName || '').trim().toLowerCase();
    const leadBadge = linkedLead ? `
      <span style="font-size:11px;color:var(--purple,#a78bfa);background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.3);padding:2px 8px;border-radius:20px;white-space:nowrap;" title="${kaKategorieLabel(linkedLead)}${leadNameDiffers ? ' · ' + linkedLead.name.replace(/</g,'&lt;') : ''}">
        <i class="ti ti-link"></i> ${kaKategorieLabel(linkedLead)}${leadNameDiffers ? ' · ' + linkedLead.name.replace(/</g,'&lt;') : ''}
      </span>
      ${kaStatusPill(linkedLead.status)}
    ` : '';
    const msgs = (chat.messages || []).slice(-30);
    const msgsHtml = msgs.map(m => {
      const isMe = m.sender === 'ich';
      const datePrefix = m.date
        ? `<span style="font-size:10px;color:var(--text3);font-weight:600;white-space:nowrap;margin-right:6px;opacity:0.7;">${m.date.replace(/</g,'&lt;')}</span>`
        : '';
      return `<div style="display:flex;gap:8px;margin-bottom:10px;align-items:flex-start;${isMe ? 'flex-direction:row-reverse;' : ''}">
        <span style="font-size:10px;font-weight:700;color:${isMe ? 'var(--purple,#a78bfa)' : 'var(--text3)'};white-space:nowrap;padding-top:5px;flex-shrink:0;">
          ${isMe ? 'Ich' : 'Kontakt'}
        </span>
        <div style="display:flex;flex-direction:column;max-width:80%;${isMe ? 'align-items:flex-end;margin-left:auto;' : 'align-items:flex-start;'}">
          ${m.date ? `<span style="font-size:10px;color:var(--text3);margin-bottom:2px;opacity:0.65;">${m.date.replace(/</g,'&lt;')}</span>` : ''}
          <span style="font-size:13px;line-height:1.6;border-radius:8px;padding:7px 11px;
            ${isMe
              ? 'background:rgba(139,92,246,0.15);color:var(--text2);'
              : 'background:rgba(255,255,255,0.06);color:var(--text);'}">
            ${m.text.replace(/</g,'&lt;')}
          </span>
        </div>
      </div>`;
    }).join('');

    return `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--border);">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-weight:700;font-size:14px;color:var(--text);">${name}</span>
              ${leadBadge}
              ${responseLabel(chat)}
            </div>
            <div style="font-size:11px;color:var(--text3);margin-top:3px;">
              Erstkontakt: ${timeAgo(chat.firstContactAt || chat.savedAt)}
              ${chat.updatedAt ? ' · Aktualisiert: ' + timeAgo(chat.updatedAt) : ''}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            <button onclick="window.kaKaSuggestReply(${idx})"
              style="display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:8px;
              border:1px solid rgba(139,92,246,0.35);background:rgba(139,92,246,0.1);
              color:var(--purple,#a78bfa);font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;"
              title="KI-Antwort vorschlagen">
              <i class="ti ti-sparkles"></i> Antwort
            </button>
            ${chat.url ? `<a href="${chat.url}" target="_blank" style="font-size:12px;color:var(--text2);text-decoration:none;border:1px solid var(--border2);border-radius:7px;padding:6px 9px;" title="Chat öffnen"><i class="ti ti-external-link"></i></a>` : ''}
            <button onclick="window.kaDeleteKaChat(${idx})"
              style="background:none;border:1px solid var(--border2);color:var(--text3);cursor:pointer;font-size:13px;padding:6px 9px;border-radius:7px;line-height:1;" title="Löschen">
              <i class="ti ti-trash"></i>
            </button>
          </div>
        </div>
        <div style="padding:12px 16px;max-height:220px;overflow-y:auto;">
          ${msgsHtml || '<p style="font-size:13px;color:var(--text3);">Keine Nachrichten.</p>'}
        </div>
        <div id="ka-reply-box-${idx}" style="display:none;padding:12px 16px;border-top:1px solid var(--border);background:var(--bg3);">
          <div style="font-size:12px;color:var(--text3);margin-bottom:8px;">KI-Antwortvorschlag:</div>
          <textarea id="ka-reply-text-${idx}" rows="3"
            style="width:100%;background:var(--bg2);border:1px solid var(--border2);color:var(--text);
            border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box;"
            placeholder="Vorschlag wird geladen…" readonly></textarea>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button onclick="navigator.clipboard.writeText(document.getElementById('ka-reply-text-${idx}').value).then(()=>window.toast?.('Kopiert ✓','success'))"
              style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:8px;border:1px solid var(--border2);background:transparent;color:var(--text2);font-size:12px;cursor:pointer;font-family:inherit;">
              <i class="ti ti-copy"></i> Kopieren
            </button>
            <button onclick="document.getElementById('ka-reply-box-${idx}').style.display='none'"
              style="padding:6px 12px;border-radius:8px;border:1px solid var(--border2);background:transparent;color:var(--text3);font-size:12px;cursor:pointer;font-family:inherit;">
              Schließen
            </button>
          </div>
        </div>
      </div>`;
  }).join('');

  return statsBar + cards;
}

window.kaDeleteKaChat = function(idx) {
  try {
    const chats = kaLoadKaChats();
    chats.splice(idx, 1);
    localStorage.setItem(KA_CHAT_KEY, JSON.stringify(chats));
    window.kaOpenTab?.('chats');
  } catch {}
};

window.kaKaSuggestReply = async function(idx) {
  const box  = document.getElementById(`ka-reply-box-${idx}`);
  const area = document.getElementById(`ka-reply-text-${idx}`);
  if (!box || !area) return;
  box.style.display = 'block';
  area.value = 'Wird generiert…';
  area.removeAttribute('readonly');

  const chats = kaLoadKaChats();
  const chat  = chats[idx];
  if (!chat) { area.value = 'Chat nicht gefunden.'; return; }

  const msgs = (chat.messages || []).slice(-10).map(m =>
    `${m.sender === 'ich' ? 'Ich' : 'Kontakt'}: ${m.text}`
  ).join('\n');

  const prompt = `Du bist ein freundlicher Finanzberater, der auf Kleinanzeigen.de nach Mitarbeitern oder Mandanten sucht.
Hier ist der bisherige Chat mit "${chat.contactName || 'der Person'}":

${msgs || '(Noch keine Nachrichten)'}

Schlage eine kurze, natürliche Antwortnachricht auf Deutsch vor (2-4 Sätze). Ziel: Interesse wecken, zum Gespräch einladen. Nur die Nachricht, kein Kommentar.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();
    area.value = data.content?.[0]?.text?.trim() || 'Kein Vorschlag generiert.';
  } catch (e) {
    area.value = 'Fehler beim Generieren: ' + e.message;
  }
};

// Live-Update wenn Extension neuen KA-Chat speichert
window.addEventListener('ka_kleinanzeigen_chat_updated', () => {
  if (document.querySelector('.nav-item.active[data-page="kleinanzeigen"]')) {
    window.kaOpenTab?.('chats');
  }
});

window.renderKleinanzeigen = function () {
  const angeCount = kaFirebaseLeads.filter(l => l.status === 'angeschrieben').length;
  const chatCount = kaLoadKaChats().length;
  const tabs = [
    { id:'aktive',        label:'<i class="ti ti-users"></i> Aktive Mitarbeiter' },
    { id:'passive',       label:'<i class="ti ti-world"></i> Passive Mitarbeiter' },
    { id:'mandantenTab',  label:'<i class="ti ti-briefcase"></i> Mandanten' },
    { id:'angeschrieben', label:`<i class="ti ti-mail"></i> Angeschrieben${angeCount > 0 ? ` <span style="background:rgba(245,158,11,0.15);color:var(--amber);border-radius:20px;padding:1px 7px;font-size:11px;">${angeCount}</span>` : ''}` },
    { id:'chats',         label:`<i class="ti ti-message-circle"></i> Chats${chatCount > 0 ? ` <span style="background:rgba(139,92,246,0.15);color:var(--purple);border-radius:20px;padding:1px 7px;font-size:11px;">${chatCount}</span>` : ''}` },
  ];
  const tabContents = {
    aktive:        kaRenderAktive,
    passive:       kaRenderPassive,
    mandantenTab:  kaRenderMandanten,
    angeschrieben: kaRenderAngeschrieben,
    chats:         kaRenderKaChats,
  };
  if (kaActiveTab === 'socialMedia') kaActiveTab = 'aktive';
  const content = tabContents[kaActiveTab]?.() || '';
  document.getElementById('content').innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--border);">
      ${tabs.map(t => kaTabBtn(t.id, t.label, kaActiveTab === t.id)).join('')}
    </div>
    <div id="ka-tab-content">${content}</div>
  `;
};

// ── Aktionen ───────────────────────────────────────────────────
window.kaMarkAngeschrieben = async function (leadId) {
  try {
    await updateDoc(doc(kaDb, 'kaLeads', leadId), { status: 'angeschrieben' });
    window.toast?.('Status auf "Angeschrieben" gesetzt ✓', 'success');
  } catch (e) {
    window.toast?.('Fehler: ' + e.message, 'error');
  }
};

window.kaDeleteLead = async function (leadId) {
  if (!confirm('Lead wirklich löschen?')) return;
  try {
    await deleteDoc(doc(kaDb, 'kaLeads', leadId));
    window.toast?.('Lead gelöscht.', 'success');
  } catch (e) {
    window.toast?.('Fehler: ' + e.message, 'error');
  }
};

window.kaOpenContactFromLead = function (leadId) {
  const lead = kaFirebaseLeads.find(l => l.id === leadId);
  if (!lead) return;
  if (typeof window.openContactModal !== 'function') {
    window.toast?.('Kontakt-Modal nicht verfügbar.', 'error');
    return;
  }
  window.openContactModal(null);
  requestAnimationFrame(async () => {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    set('f_vorname',  lead.name?.split(' ')[0] || '');
    set('f_nachname', lead.name?.split(' ').slice(1).join(' ') || '');
    set('f_ort',      lead.ort || '');
    set('f_quelle',   'Kleinanzeigen');
    set('f_thema',    lead.kategorie === 'mandanten' ? 'Mandant (' + (lead.subKat || '') + ')' : 'Nebenverdienst');
    set('f_status',   'Neu');
    set('f_notizen',  `KA-Link: ${lead.link}\n\n${lead.text || ''}`);
    const title = document.getElementById('modalTitle');
    if (title) title.textContent = 'Kontakt aus Kleinanzeigen anlegen';
    // Status auf kontakt_angelegt setzen
    try { await updateDoc(doc(kaDb, 'kaLeads', leadId), { status: 'kontakt_angelegt' }); } catch {}
  });
};

// ── Tab-Navigation ─────────────────────────────────────────────
window.kaOpenTab        = id => { kaActiveTab = id; renderKleinanzeigen(); };
window.kaOpenSubTab     = id => { kaActiveSubTab = id; if (id === 'sub-steuerberater') kaActiveNestedTab = 'steuer-privat-pane'; renderKleinanzeigen(); };
window.kaCopy = function(id) {
  const el = document.getElementById(id);
  if (!el) { window.toast?.('Textfeld nicht gefunden.', 'error'); return; }
  navigator.clipboard.writeText(el.value).then(() => window.toast?.('Nachricht kopiert! ✓', 'success'));
};
window.kaOpenNestedTab  = id => { kaActiveNestedTab = id; renderKleinanzeigen(); };
window.kaRenderSocialMedia = kaRenderSocialMedia;

// Aktualisiert alle Stellen, an denen die Social-Media-Inbox angezeigt wird
// (Kleinanzeigen-Tab UND der "Chats"-Tab im Social-Media-Panel)
window.kaRefreshSocialMedia = function() {
  const html = kaRenderSocialMedia();
  const ka = document.getElementById('ka-tab-content');
  if (ka) ka.innerHTML = html;
  // Chats-Tab im Social-Media-Panel: Checkboxen + Plattform-Akkordeons einfügen
  const platBox = document.getElementById('smTabPlatforms');
  const body    = document.getElementById('smChatsBody');
  if (platBox) platBox.innerHTML = ''; // Checkboxen werden im kaRenderSocialMedia HTML integriert
  if (body)    body.innerHTML = html;
};
window.kaSocialSetFilter = function(kanal) {
  kaSocialActiveFilter = kanal;
  const el = document.getElementById('ka-tab-content');
  window.kaRefreshSocialMedia?.();
};

window.kaSocialToggleChannel = function(kanal) {
  if (kaSocialActiveChannels.has(kanal)) {
    kaSocialActiveChannels.delete(kanal);
  } else {
    kaSocialActiveChannels.add(kanal);
  }
  const el = document.getElementById('ka-tab-content');
  window.kaRefreshSocialMedia?.();
};

window.kaSocialSaveMessage = async function() {
  const kanal    = document.getElementById('sm_kanal')?.value;
  const absender = document.getElementById('sm_absender')?.value?.trim();
  const text     = document.getElementById('sm_text')?.value?.trim();
  if (!kanal)    { window.toast?.('Bitte einen Kanal auswählen.', 'error'); return; }
  if (!absender) { window.toast?.('Bitte den Absendernamen eingeben.', 'error'); return; }
  if (!text)     { window.toast?.('Bitte die Nachricht eingeben.', 'error'); return; }
  try {
    await addDoc(collection(kaDb, 'socialMessages'), {
      kanal, absender, text,
      status: 'neu',
      eingelesen: new Date(),
      quelle: 'manuell',   // 'manuell' | 'extension' – Extension-ready
      profilLink: '',
      avatar: '',
    });
    document.getElementById('sm_absender').value = '';
    document.getElementById('sm_text').value     = '';
    window.toast?.('Nachricht gespeichert ✓', 'success');
  } catch (e) {
    window.toast?.('Fehler: ' + e.message, 'error');
  }
};

window.kaSocialDeleteMessage = async function(id) {
  if (!confirm('Nachricht löschen?')) return;
  try {
    await deleteDoc(doc(kaDb, 'socialMessages', id));
    window.toast?.('Gelöscht.', 'success');
  } catch (e) {
    window.toast?.('Fehler: ' + e.message, 'error');
  }
};

window.kaSocialAddContact = async function(id) {
  const msg = kaSocialMessages.find(m => m.id === id);
  if (!msg) return;
  if (typeof window.openContactModal !== 'function') {
    window.toast?.('Kontakt-Modal nicht verfügbar.', 'error');
    return;
  }
  window.openContactModal(null);
  requestAnimationFrame(async () => {
    const set = (fid, val) => { const el = document.getElementById(fid); if (el) el.value = val || ''; };
    const parts = (msg.absender || '').trim().split(' ');
    set('f_vorname',  parts[0] || '');
    set('f_nachname', parts.slice(1).join(' ') || '');
    set('f_quelle',   msg.kanal || 'Social Media');
    set('f_thema',    'Social Media');
    set('f_status',   'Neu');
    set('f_notizen',  `Kanal: ${msg.kanal}\n\nNachricht:\n"${msg.text}"`);
    const title = document.getElementById('modalTitle');
    if (title) title.textContent = `Kontakt aus ${msg.kanal} anlegen`;
    try { await updateDoc(doc(kaDb, 'socialMessages', id), { status: 'kontakt_angelegt' }); } catch {}
  });
};

// ── Init ───────────────────────────────────────────────────────
// Firebase sofort starten — app.js lädt parallel, Firebase-SDK dedupliziert die App-Instanz
kaInitFirebase();

// pages-Eintrag ist bereits in app.js definiert (window.pages).
// Kein separates Registrieren nötig – verhindert frühere setTimeout-Endlosschleife.
