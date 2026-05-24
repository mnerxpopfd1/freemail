/**
 * 邮件事件处理器
 * @module email/handler
 */

import { getInitializedDatabase } from '../db/index.js';
import { extractEmail, normalizeEmailAlias } from '../utils/common.js';
import { forwardByLocalPart, forwardByMailboxConfig } from './forwarder.js';
import { parseEmailBody, extractVerificationCode } from './parser.js';
import { getForwardTarget } from '../db/mailboxes.js';
import { getMailStore, putMailObject } from './storage.js';

export async function handleEmailEvent(message, env, ctx) {
  let DB;
  try {
    DB = await getInitializedDatabase(env);
  } catch (error) {
    console.error('邮件处理时数据库连接失败:', error.message);
    return;
  }

  try {
    const headers = message.headers;
    const toHeader = headers.get('to') || headers.get('To') || '';
    const fromHeader = headers.get('from') || headers.get('From') || '';
    const subject = headers.get('subject') || headers.get('Subject') || '(无主题)';

    let envelopeTo = '';
    try {
      const toValue = message.to;
      if (Array.isArray(toValue) && toValue.length > 0) {
        envelopeTo = typeof toValue[0] === 'string' ? toValue[0] : (toValue[0].address || '');
      } else if (typeof toValue === 'string') {
        envelopeTo = toValue;
      }
    } catch (_) { }

    const resolvedRecipient = (envelopeTo || toHeader || '').toString();
    const resolvedAddr = extractEmail(resolvedRecipient);
    const normalizedAddr = normalizeEmailAlias(resolvedAddr);
    const localPart = (normalizedAddr.split('@')[0] || '').toLowerCase();

    const mailboxForwardTo = await getForwardTarget(DB, normalizedAddr);
    if (mailboxForwardTo) {
      forwardByMailboxConfig(message, mailboxForwardTo, ctx);
    } else {
      forwardByLocalPart(message, localPart, ctx, env);
    }

    let textContent = '';
    let htmlContent = '';
    let rawBuffer = null;
    try {
      const resp = new Response(message.raw);
      rawBuffer = await resp.arrayBuffer();
      const rawText = await new Response(rawBuffer).text();
      const parsed = await parseEmailBody(rawText);
      textContent = parsed.text || '';
      htmlContent = parsed.html || '';
      if (!textContent && !htmlContent) textContent = (rawText || '').slice(0, 100000);
    } catch (_) { }

    const mailbox = normalizedAddr || normalizeEmailAlias(extractEmail(toHeader));
    const sender = extractEmail(fromHeader);

    const mailStore = getMailStore(env);
    let objectKey = '';
    let objectBucket = '';
    try {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, '0');
      const d = String(now.getUTCDate()).padStart(2, '0');
      const hh = String(now.getUTCHours()).padStart(2, '0');
      const mm = String(now.getUTCMinutes()).padStart(2, '0');
      const ss = String(now.getUTCSeconds()).padStart(2, '0');
      const keyId = (globalThis.crypto?.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const safeMailbox = (mailbox || 'unknown').toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
      objectKey = `${y}/${m}/${d}/${safeMailbox}/${hh}${mm}${ss}-${keyId}.eml`;
      if (rawBuffer) {
        objectBucket = await putMailObject(mailStore, objectKey, rawBuffer);
      }
    } catch (e) {
      console.error('邮件原文存储失败:', e);
      objectKey = '';
      objectBucket = '';
    }

    const preview = String(
      (textContent?.trim() ? textContent : (htmlContent || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) || ''
    ).slice(0, 120);
    let verificationCode = '';
    try { verificationCode = extractVerificationCode({ subject, text: textContent, html: htmlContent }); } catch (_) { }

    const resMb = await DB.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(mailbox.toLowerCase()).all();
    let mailboxId;
    if (Array.isArray(resMb?.results) && resMb.results.length) {
      mailboxId = resMb.results[0].id;
    } else {
      const [localPartMb, domain] = (mailbox || '').toLowerCase().split('@');
      if (localPartMb && domain) {
        await DB.prepare('INSERT INTO mailboxes (address, local_part, domain, password_hash, last_accessed_at) VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP)')
          .bind((mailbox || '').toLowerCase(), localPartMb, domain).run();
        const created = await DB.prepare('SELECT id FROM mailboxes WHERE address = ?').bind((mailbox || '').toLowerCase()).all();
        mailboxId = created?.results?.[0]?.id;
      }
    }
    if (!mailboxId) throw new Error('无法解析或创建 mailbox 记录');

    let toAddrs = '';
    try {
      const toValue = message.to;
      if (Array.isArray(toValue)) {
        toAddrs = toValue.map(v => (typeof v === 'string' ? v : (v?.address || ''))).filter(Boolean).join(',');
      } else if (typeof toValue === 'string') {
        toAddrs = toValue;
      } else {
        toAddrs = resolvedRecipient || toHeader || '';
      }
    } catch (_) { toAddrs = resolvedRecipient || toHeader || ''; }

    await DB.prepare(`
      INSERT INTO messages (mailbox_id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(mailboxId, sender, String(toAddrs || ''), subject || '(无主题)', verificationCode || null, preview || null, objectBucket || '', objectKey || '').run();
  } catch (err) {
    console.error('Email event handling error:', err);
  }
}
