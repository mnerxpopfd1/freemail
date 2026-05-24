/**
 * 邮件原始内容存储适配器。
 * 默认优先使用 Cloudflare Workers KV，兼容回退到原 R2。
 * @module email/storage
 */

export const MAIL_STORE_KV_BUCKET = 'mail-kv';
export const MAIL_STORE_R2_BUCKET = 'mail-eml';

export function getMailStore(env = {}) {
  return {
    kv: env.MAIL_KV || env.MAIL_EML_KV || null,
    r2: env.MAIL_EML || null
  };
}

export function hasMailStore(store) {
  return !!(store?.kv || store?.r2);
}

export async function putMailObject(store, key, value) {
  if (!key || value == null) return '';

  if (store?.kv) {
    await store.kv.put(key, value);
    return MAIL_STORE_KV_BUCKET;
  }

  if (store?.r2) {
    await store.r2.put(key, value, { httpMetadata: { contentType: 'message/rfc822' } });
    return MAIL_STORE_R2_BUCKET;
  }

  return '';
}

export async function getMailObject(store, bucket, key) {
  if (!key) return null;

  if (bucket === MAIL_STORE_R2_BUCKET) {
    return getR2Object(store?.r2, key);
  }

  if (bucket === MAIL_STORE_KV_BUCKET) {
    return getKvObject(store?.kv, key);
  }

  return (await getKvObject(store?.kv, key)) || (await getR2Object(store?.r2, key));
}

export async function deleteMailObject(store, bucket, key) {
  if (!key) return;

  if (bucket === MAIL_STORE_R2_BUCKET) {
    if (store?.r2) await store.r2.delete(key);
    return;
  }

  if (bucket === MAIL_STORE_KV_BUCKET) {
    if (store?.kv) await store.kv.delete(key);
    return;
  }

  if (store?.kv) await store.kv.delete(key);
  if (store?.r2) await store.r2.delete(key);
}

async function getKvObject(kv, key) {
  if (!kv || !key) return null;
  const value = await kv.get(key, { type: 'arrayBuffer' });
  if (!value) return null;
  return {
    body: value,
    async text() {
      return new TextDecoder().decode(value);
    },
    async arrayBuffer() {
      return value;
    }
  };
}

async function getR2Object(r2, key) {
  if (!r2 || !key) return null;
  return r2.get(key);
}
