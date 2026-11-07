/**
 * WAiDrop - Message Parser (v2)
 *
 * Pure DOM helpers distilled from the live DOM probe (Oct 2026, WhatsApp Web
 * build 2.3000.1050712378). Loaded as a content script BEFORE content.js.
 * Also evaluated directly in tests via window.eval (no chrome APIs here).
 *
 * Verified row anatomy:
 *   #main div[role="row"]
 *     └─ [data-testid^="conv-msg-"][data-id]          <- message cell (msgId)
 *         └─ div[data-virtualized="false"]
 *             └─ …div.focusable-list-item              <- alignment host (flex-start|flex-end)
 *                 └─ [data-testid="msg-container"]     <- bubble
 *                     ├─ [data-icon="tail-in"|"tail-out"]        <- direction (burst leader)
 *                     ├─ .copyable-text[data-pre-plain-text]     <- "[HH:MM, DD.MM.YYYY] Sender: "
 *                     ├─ [data-testid="selectable-text"]         <- message text
 *                     ├─ [data-testid="author"]                  <- group sender (incoming only)
 *                     └─ [data-testid="msg-meta"][role=button]   <- outgoing marker
 *
 * Exposes window.WAControlParser.
 */
(function () {
  'use strict';

  const MONTH_FIRST_REGIONS = new Set(['US', 'PH']);

  function parseTimeOfDay(str) {
    if (!str) return null;
    const m = String(str).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap]\.?\s?[Mm]\.?)?$/);
    if (!m) return null;
    let hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const ap = m[4] ? m[4].toLowerCase() : null;
    if (ap) {
      if (ap.startsWith('p') && hours < 12) hours += 12;
      if (ap.startsWith('a') && hours === 12) hours = 0;
    }
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
  }

  function parseDateFields(str, locale, nowMs) {
    if (!str) return null;
    const m = String(str).trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    let year = parseInt(m[3], 10);
    if (year < 100) year += year < 70 ? 2000 : 1900;

    let day;
    let month;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      day = b;
      month = a;
    } else if (a > 12 && b > 12) {
      return null;
    } else {
      const now = typeof nowMs === 'number' ? nowMs : Date.now();
      const dayFirstOk = new Date(year, b - 1, a).getTime() <= now + 86400000;
      const monthFirstOk = new Date(year, a - 1, b).getTime() <= now + 86400000;
      const region = (String(locale || '').toUpperCase().split(/[-_]/)[1] || '');
      if (dayFirstOk && !monthFirstOk) {
        day = a;
        month = b;
      } else if (monthFirstOk && !dayFirstOk) {
        day = b;
        month = a;
      } else if (MONTH_FIRST_REGIONS.has(region)) {
        month = a;
        day = b;
      } else {
        day = a;
        month = b;
      }
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { day, month, year };
  }

  /**
   * Parse data-pre-plain-text ("[13:45, 17.10.2026] Jane: ").
   * Returns { ts, sender, timeStr, dateStr }; ts is null when unparseable.
   */
  function parsePrePlainText(raw, options) {
    const out = { ts: null, sender: null, timeStr: null, dateStr: null };
    if (!raw || typeof raw !== 'string') return out;
    const locale =
      (options && options.locale) ||
      (typeof navigator !== 'undefined' && navigator.language) ||
      'en-US';
    const inner = raw.match(/^\[([^\]]*)\]\s*([\s\S]*)$/);
    if (!inner) return out;
    const meta = inner[1];
    const sender = (inner[2] || '').trim().replace(/:\s*$/, '').trim();
    out.sender = sender || null;

    let timeStr = null;
    let dateStr = null;
    const parts = meta.split(',').map((s) => s.trim());
    if (parts.length >= 2) {
      timeStr = parts[0];
      dateStr = parts[1];
    } else if (parts[0]) {
      if (/^\d{1,2}:\d{2}/.test(parts[0])) timeStr = parts[0];
      else dateStr = parts[0];
    }
    out.timeStr = timeStr;
    out.dateStr = dateStr;

    const time = parseTimeOfDay(timeStr);
    const date = parseDateFields(dateStr, locale, options && options.now);
    if (time && date) {
      out.ts = new Date(date.year, date.month - 1, date.day, time.hours, time.minutes, 0, 0).getTime();
    }
    return out;
  }

  function findCell(row) {
    if (!row) return null;
    if (row.matches && row.matches('[data-testid^="conv-msg-"]')) return row;
    return row.querySelector ? row.querySelector('[data-testid^="conv-msg-"]') : null;
  }

  function messageIdFromCell(cell) {
    if (!cell) return null;
    const did = cell.getAttribute('data-id');
    if (did) return did;
    const tid = cell.getAttribute('data-testid') || '';
    return tid.startsWith('conv-msg-') ? tid.slice('conv-msg-'.length) : null;
  }

  function isSystemRow(row) {
    if (!row || !row.querySelector) return false;
    return !!(
      row.querySelector('[data-testid="msg-notification-container"]') ||
      row.querySelector('[data-testid="system_message"]')
    );
  }

  /**
   * Direction cascade (all signals verified to agree on live data):
   * 1. tail-in / tail-out icon; 2. msg-meta[role=button] => outgoing;
   * 3. alignment host computed style; 4. bubble geometry vs #main.
   */
  function detectDirection(row, bubble) {
    if (bubble) {
      if (bubble.querySelector('[data-icon="tail-out"], [data-testid="tail-out"]')) return 'out';
      if (bubble.querySelector('[data-icon="tail-in"], [data-testid="tail-in"]')) return 'in';
      const meta = bubble.querySelector('[data-testid="msg-meta"]');
      if (meta && meta.getAttribute('role') === 'button') return 'out';
    }
    const host = bubble && bubble.parentElement;
    if (host && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const ai = window.getComputedStyle(host).alignItems;
        if (ai === 'flex-end' || ai === 'end') return 'out';
        if (ai === 'flex-start' || ai === 'start') return 'in';
      } catch (e) {
        /* ignore */
      }
    }
    try {
      const main = document.querySelector('#main');
      const target = bubble || row;
      if (main && target && target.getBoundingClientRect) {
        const mr = main.getBoundingClientRect();
        const br = target.getBoundingClientRect();
        if (mr.width > 0 && br.width > 0) {
          const mainCenter = mr.left + mr.width / 2;
          const bubbleCenter = br.left + br.width / 2;
          if (bubbleCenter > mainCenter + mr.width * 0.05) return 'out';
          if (bubbleCenter < mainCenter - mr.width * 0.05) return 'in';
        }
      }
    } catch (e) {
      /* ignore */
    }
    return 'unknown';
  }

  function getChatContext(main) {
    const root = main || (typeof document !== 'undefined' ? document.querySelector('#main') : null);
    if (!root) return { chatName: 'unknown', isGroup: false };
    const titleEl = root.querySelector('[data-testid="conversation-info-header-chat-title"]');
    const chatName = titleEl ? (titleEl.textContent || '').trim() : '';
    const isGroup = !!root.querySelector('[data-testid="author"]');
    return { chatName: chatName || 'unknown', isGroup };
  }

  function parseMessageRow(row, ctx, options) {
    if (!row) return null;
    const cell = findCell(row);
    if (!cell) return null;
    const msgId = messageIdFromCell(cell);
    if (!msgId) return null;

    const bubble = cell.querySelector('[data-testid="msg-container"]') || cell;
    const direction = detectDirection(row, bubble);

    const prePlainEl = cell.querySelector('[data-pre-plain-text]');
    const prePlain = prePlainEl ? parsePrePlainText(prePlainEl.getAttribute('data-pre-plain-text'), options) : null;

    const authorEl = cell.querySelector('[data-testid="author"]');
    const author = authorEl ? (authorEl.textContent || '').trim() : null;

    let text = '';
    const textEl = cell.querySelector('[data-testid="selectable-text"]');
    if (textEl) text = (textEl.textContent || '').trim();

    const media = cell.querySelector(
      '[data-testid="media-url-provider"], video, audio, img[src^="blob:"]:not([class*="emoji"]), [data-testid="sticker-container"]'
    );
    let type = 'unknown';
    if (media) type = 'media';
    else if (text) type = 'text';

    const chatName = (ctx && ctx.chatName) || 'unknown';
    let senderName = author || (prePlain && prePlain.sender) || null;
    if (!senderName) senderName = direction === 'out' ? 'You' : chatName;

    return {
      v: 1,
      msgId,
      chatName,
      isGroup: !!(ctx && ctx.isGroup),
      direction,
      senderName,
      text,
      ts: prePlain && prePlain.ts != null ? prePlain.ts : null,
      tsRaw: prePlainEl ? prePlainEl.getAttribute('data-pre-plain-text') : null,
      type,
      capturedAt: Date.now(),
      source: 'dom',
    };
  }

  const API = {
    parseMessageRow,
    parsePrePlainText,
    parseTimeOfDay,
    parseDateFields,
    detectDirection,
    isSystemRow,
    findCell,
    messageIdFromCell,
    getChatContext,
  };

  if (typeof window !== 'undefined') window.WAControlParser = API;
})();
