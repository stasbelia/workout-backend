const { randomUUID } = require('node:crypto');
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const AvatarError = require('./avatarErrors');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
const { fromIni } = require('@aws-sdk/credential-providers');

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 300;
const IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
]);

// credentials передаємо явно лише в тестах. На VPS читається іменований профіль.
function createAvatarStorage({ env = process.env, credentials, client: injectedClient } = {}) {
  let client = injectedClient;

  function getClient() {
    if (!env.AWS_REGION || !env.S3_AVATAR_BUCKET) throw new Error('Сховище аватарів не налаштоване.');
    client ??= new S3Client({
      region: env.AWS_REGION,
      credentials: credentials ?? fromIni({ profile: env.AWS_PROFILE || 'workout-tracker' }),
    });
    return client;
  }

  async function send(command) {
    return getClient().send(command, { abortSignal: AbortSignal.timeout(15_000) });
  }

  return {
    async createUpload({ userId, contentType }) {
      const extension = IMAGE_EXTENSIONS.get(contentType);
      if (!Number.isSafeInteger(userId) || userId <= 0 || !extension) {
        throw new TypeError('Некоректні параметри аватара.');
      }

      const region = env.AWS_REGION;
      const bucket = env.S3_AVATAR_BUCKET;
      if (!region || !bucket) {
        throw new Error('Сховище аватарів не налаштоване.');
      }

      // Ліниве створення: відсутнє налаштування S3 не ламає вхід у застосунок.
      getClient();

      // ID береться з перевіреного JWT, випадкова назва запобігає колізіям.
      // pending означає: файл ще не перевірено й не призначено аватаром.
      const key = `avatars/pending/${userId}/${randomUUID()}.${extension}`;
      const { url, fields } = await createPresignedPost(client, {
        Bucket: bucket,
        Key: key,
        Expires: UPLOAD_TTL_SECONDS,
        Fields: { 'Content-Type': contentType },
        Conditions: [
          ['content-length-range', 1, MAX_AVATAR_BYTES],
          ['eq', '$Content-Type', contentType],
        ],
      });

      return { url, fields, key, expiresIn: UPLOAD_TTL_SECONDS, maxFileSize: MAX_AVATAR_BYTES };
    },

    async readPending(key) {
      let result;
      const signal = AbortSignal.timeout(15_000);
      try {
        result = await getClient().send(new GetObjectCommand({ Bucket: env.S3_AVATAR_BUCKET, Key: key }), { abortSignal: signal });
      } catch (error) {
        if (error.name === 'NoSuchKey') throw new AvatarError(400, 'Фото не знайдено. Завантажте його ще раз.');
        throw error;
      }
      if (!result.Body || !Number.isSafeInteger(result.ContentLength) || result.ContentLength < 1 || result.ContentLength > MAX_AVATAR_BYTES) {
        result.Body?.destroy?.();
        throw new AvatarError(400, 'Розмір фото має бути від 1 байта до 5 МіБ.');
      }
      // Не довіряємо лише Content-Length: читаємо потік з власним лімітом.
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of result.Body) {
          signal.throwIfAborted();
          size += chunk.length;
          if (size > MAX_AVATAR_BYTES) throw new AvatarError(400, 'Фото перевищує 5 МіБ.');
          chunks.push(chunk);
        }
        if (size !== result.ContentLength) throw new AvatarError(400, 'Фото передано не повністю.');
        return Buffer.concat(chunks);
      } finally {
        result.Body.destroy?.();
      }
    },

    async saveVerified(key, bytes) {
      await send(new PutObjectCommand({
        Bucket: env.S3_AVATAR_BUCKET, Key: key, Body: bytes,
        ContentType: 'image/jpeg', CacheControl: 'private, max-age=900',
        ServerSideEncryption: 'AES256', IfNoneMatch: '*',
      }));
    },

    async readUrl(key) {
      const url = await getSignedUrl(getClient(), new GetObjectCommand({ Bucket: env.S3_AVATAR_BUCKET, Key: key }), { expiresIn: 900 });
      return { url, expiresAt: new Date(Date.now() + 900_000).toISOString() };
    },

    async remove(key) {
      await send(new DeleteObjectCommand({ Bucket: env.S3_AVATAR_BUCKET, Key: key }));
    },
  };
}

module.exports = { createAvatarStorage, MAX_AVATAR_BYTES, IMAGE_EXTENSIONS };
